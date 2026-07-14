import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AgentToolCall } from "@/lib/llm/provider";
import type { AuthorizedUser } from "@/lib/auth/guards";
import type { AgentStreamEvent } from "@/lib/agent/loop";
import { runBridgedTool } from "@/lib/agent/bridge";
import { fetchModuleRecords, normalize, type MirrorRecord } from "@/lib/records/mirror";
import { maxBatchItemsPerCall, emailBatchMaxWallMs } from "@/lib/agent/runtime-config";

type Emit = (event: AgentStreamEvent) => void | Promise<void>;

const emailBatchItemSchema = z.object({
  reference: z.string().trim().min(1).max(80),
  to_email: z.string().trim().email(),
  to_name: z.string().trim().min(1).max(200).optional(),
  cc: z.array(z.string().trim().email()).max(20).default([]),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
  schedule_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "schedule_date must be YYYY-MM-DD"),
  schedule_time: z.string().trim().min(1).max(20)
});

export function emailBatchArgsSchema() {
  return z
    .object({
      batch_reference: z.string().trim().min(1).max(80),
      timezone: z.string().trim().min(1).max(64).default("Asia/Kolkata"),
      items: z.array(emailBatchItemSchema).min(1).max(maxBatchItemsPerCall())
    })
    .refine(
      (args) => new Set(args.items.map((item) => item.reference)).size === args.items.length,
      { message: "Each item.reference must be unique within the batch." }
    );
}

export type EmailBatchArgs = z.infer<ReturnType<typeof emailBatchArgsSchema>>;
export type EmailBatchItemArgs = EmailBatchArgs["items"][number];

type LedgerStatus = "pending" | "resolving" | "scheduled" | "failed" | "skipped_duplicate";

type LedgerRow = {
  id: string;
  item_reference: string;
  to_email: string;
  subject: string;
  schedule_date: string;
  schedule_time: string;
  status: LedgerStatus;
  deal_name: string | null;
  error_message: string | null;
};

type ItemReport = {
  item_reference: string;
  status: LedgerStatus;
  deal_name?: string | null;
  error_message?: string;
};

function asRecordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function lookupZohoId(value: unknown): string | null {
  const object = asRecordObject(value);
  return typeof object?.id === "string" && object.id.trim() ? object.id.trim() : null;
}

// Reuses the same Supabase-mirror internals db_search_records/db_query use
// (fetchModuleRecords over the accounts/contacts/deals mirror) rather than
// issuing new Zoho API calls. Deals do not expose a contact-linkage column
// through MIRROR_MODULES.deals.select, but every deal's raw_data payload is
// the live Zoho record, which always carries the Contact_Name lookup
// ({id, name}) when a primary contact is set - the same field zoho-upsert.ts
// uses to populate deals.primary_contact_id.
async function resolveContactAndDeal(
  supabase: SupabaseClient,
  toEmail: string
): Promise<
  | { ok: true; contact: { zoho_id: string; name: string }; deal: { zoho_id: string; name: string; url: string | null } }
  | { ok: false; error_message: string }
> {
  const needle = normalize(toEmail);
  const contacts = await fetchModuleRecords(supabase, "contacts");
  const contactMatches = contacts.filter((record) => normalize(record.data.email) === needle);

  if (contactMatches.length === 0) {
    return { ok: false, error_message: `No contact found in the mirror with email "${toEmail}".` };
  }
  if (contactMatches.length > 1) {
    const candidates = contactMatches.map((record) => `${record.name} (${record.zoho_id})`).join(", ");
    return {
      ok: false,
      error_message: `Ambiguous contact for email "${toEmail}": ${contactMatches.length} candidates found - ${candidates}.`
    };
  }
  const contact = contactMatches[0];
  if (!contact.zoho_id) {
    return { ok: false, error_message: `Contact "${contact.name}" for email "${toEmail}" has no Zoho id in the mirror.` };
  }

  const deals = await fetchModuleRecords(supabase, "deals");
  const dealMatches = deals.filter((record: MirrorRecord) => lookupZohoId(record.raw.Contact_Name) === contact.zoho_id);

  if (dealMatches.length === 0) {
    return {
      ok: false,
      error_message: `No deal found in the mirror linked to contact "${contact.name}" (${contact.zoho_id}) via Contact_Name.`
    };
  }
  if (dealMatches.length > 1) {
    const candidates = dealMatches.map((record) => `${record.name} (${record.zoho_id})`).join(", ");
    return {
      ok: false,
      error_message: `Ambiguous deal for contact "${contact.name}" (${contact.zoho_id}): ${dealMatches.length} candidates found - ${candidates}.`
    };
  }
  const deal = dealMatches[0];
  if (!deal.zoho_id) {
    return { ok: false, error_message: `Deal "${deal.name}" linked to contact "${contact.name}" has no Zoho id in the mirror.` };
  }

  return {
    ok: true,
    contact: { zoho_id: contact.zoho_id, name: contact.name },
    deal: { zoho_id: deal.zoho_id, name: deal.name, url: deal.zoho_url }
  };
}

const LEDGER_ROW_SELECT = "id,item_reference,to_email,subject,schedule_date,schedule_time,status,deal_name,error_message";

// Resumability: a row already 'scheduled' or 'skipped_duplicate' is a
// terminal, already-reported outcome. Return it untouched instead of
// upserting - a re-run with (accidentally or intentionally) edited item
// content must never rewrite the record of what was actually scheduled.
async function upsertLedgerRow(
  service: SupabaseClient,
  userId: string,
  batchReference: string,
  item: EmailBatchItemArgs,
  timezone: string
): Promise<LedgerRow> {
  const { data: existing, error: selectError } = await service
    .from("email_batch_items")
    .select(LEDGER_ROW_SELECT)
    .eq("user_id", userId)
    .eq("batch_reference", batchReference)
    .eq("item_reference", item.reference)
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing && (existing.status === "scheduled" || existing.status === "skipped_duplicate")) {
    return existing as LedgerRow;
  }

  const { data, error } = await service
    .from("email_batch_items")
    .upsert(
      {
        user_id: userId,
        batch_reference: batchReference,
        item_reference: item.reference,
        to_email: item.to_email.trim().toLowerCase(),
        to_name: item.to_name ?? null,
        cc: item.cc.map((email) => email.trim().toLowerCase()),
        subject: item.subject,
        body: item.body,
        schedule_date: item.schedule_date,
        schedule_time: item.schedule_time,
        timezone,
        status: "pending",
        error_message: null
      },
      { onConflict: "user_id,batch_reference,item_reference", ignoreDuplicates: false }
    )
    .select(LEDGER_ROW_SELECT)
    .single();

  if (error) throw error;
  return data as LedgerRow;
}

async function markLedgerRow(
  service: SupabaseClient,
  rowId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await service.from("email_batch_items").update(patch).eq("id", rowId);
  if (error) throw error;
}

async function findScheduledDuplicate(
  service: SupabaseClient,
  userId: string,
  item: EmailBatchItemArgs,
  excludeRowId: string
): Promise<{ batch_reference: string; item_reference: string } | null> {
  const { data, error } = await service
    .from("email_batch_items")
    .select("id,batch_reference,item_reference")
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .eq("to_email", item.to_email.trim().toLowerCase())
    .eq("subject", item.subject)
    .eq("schedule_date", item.schedule_date)
    .eq("schedule_time", item.schedule_time)
    .neq("id", excludeRowId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { batch_reference: data.batch_reference as string, item_reference: data.item_reference as string };
}

export async function runEmailBatchTool(input: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown }> {
  const { service, user, sessionId, call, emit } = input;
  const args = emailBatchArgsSchema().parse(call.args) as EmailBatchArgs;
  const startedAt = Date.now();
  const wallMs = emailBatchMaxWallMs();

  const items: ItemReport[] = [];
  let scheduled = 0;
  let skippedDuplicate = 0;
  let failed = 0;
  let alreadyDone = 0;
  let pending = 0;

  for (let index = 0; index < args.items.length; index += 1) {
    const item = args.items[index];
    const progress = `item ${index + 1}/${args.items.length}`;

    // Resumability check first (cheap DB read/upsert, not extension work):
    // an item already terminal in the ledger is reported as already_done
    // even if this call is out of wall-clock budget - it costs nothing to
    // report, and only fresh dispatch work should be deferred to a
    // follow-up call.
    const row = await upsertLedgerRow(service, user.id, args.batch_reference, item, args.timezone);

    if (row.status === "scheduled" || row.status === "skipped_duplicate") {
      alreadyDone += 1;
      if (row.status === "scheduled") scheduled += 1;
      else skippedDuplicate += 1;
      items.push({
        item_reference: item.reference,
        status: row.status,
        deal_name: row.deal_name,
        error_message: row.error_message ?? undefined
      });
      continue;
    }

    if (Date.now() - startedAt > wallMs) {
      // Wall-clock guard: leave this and every remaining item 'pending' in
      // the ledger so a follow-up call with the same batch_reference picks
      // up exactly where this call stopped.
      pending += args.items.length - index;
      items.push({ item_reference: item.reference, status: "pending" });
      continue;
    }

    await emit({ type: "assistant_delta", text: `\n${progress}: checking for duplicates...` });
    const duplicate = await findScheduledDuplicate(service, user.id, item, row.id);
    if (duplicate) {
      const message = `Duplicate of ${duplicate.batch_reference}/${duplicate.item_reference} (same recipient, subject, date, and time already scheduled).`;
      await markLedgerRow(service, row.id, { status: "skipped_duplicate", error_message: message });
      skippedDuplicate += 1;
      items.push({ item_reference: item.reference, status: "skipped_duplicate", error_message: message });
      continue;
    }

    await markLedgerRow(service, row.id, { status: "resolving" });
    await emit({ type: "assistant_delta", text: `\n${progress}: resolving contact and deal for ${item.to_email}...` });
    const resolution = await resolveContactAndDeal(service, item.to_email);
    if (!resolution.ok) {
      await markLedgerRow(service, row.id, { status: "failed", error_message: resolution.error_message });
      failed += 1;
      items.push({ item_reference: item.reference, status: "failed", error_message: resolution.error_message });
      continue;
    }

    await markLedgerRow(service, row.id, {
      deal_zoho_id: resolution.deal.zoho_id,
      deal_name: resolution.deal.name,
      deal_url: resolution.deal.url,
      contact_zoho_id: resolution.contact.zoho_id
    });

    await emit({
      type: "assistant_delta",
      text: `\n${progress}: scheduling email to ${item.to_email} for deal "${resolution.deal.name}"...`
    });

    const jobCall: AgentToolCall = {
      id: `${call.id}:${item.reference}`,
      name: "schedule_zoho_email",
      args: {
        reference: `${args.batch_reference}/${item.reference}`,
        deal_url: resolution.deal.url ?? "",
        deal_zoho_id: resolution.deal.zoho_id,
        deal_name: resolution.deal.name,
        contact_zoho_id: resolution.contact.zoho_id,
        contact_name: resolution.contact.name,
        to: item.to_email,
        cc: item.cc,
        subject: item.subject,
        body: item.body,
        schedule_date: item.schedule_date,
        schedule_time: item.schedule_time,
        timezone: args.timezone,
        new_tasks: [],
        tasks_to_complete: []
      }
    };

    try {
      const jobResult = await runBridgedTool({
        service,
        user,
        sessionId,
        call: jobCall,
        timeoutMs: 360_000,
        onStatus: (status) =>
          emit({ type: "tool_status", call_id: call.id, tool_name: "schedule_zoho_email", status })
      });
      const resultObject = asRecordObject(jobResult);
      const receipt = resultObject
        ? { draft_verification: resultObject.draft_verification ?? null, schedule_verification: resultObject.schedule_verification ?? null }
        : null;
      await markLedgerRow(service, row.id, { status: "scheduled", receipt, error_message: null });
      scheduled += 1;
      items.push({ item_reference: item.reference, status: "scheduled", deal_name: resolution.deal.name });
      await emit({ type: "assistant_delta", text: ` scheduled.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "schedule_zoho_email job failed.";
      await markLedgerRow(service, row.id, { status: "failed", error_message: message });
      failed += 1;
      items.push({ item_reference: item.reference, status: "failed", deal_name: resolution.deal.name, error_message: message });
      await emit({ type: "assistant_delta", text: ` failed: ${message}` });
    }
  }

  const result = {
    batch_reference: args.batch_reference,
    totals: {
      requested: args.items.length,
      scheduled,
      skipped_duplicate: skippedDuplicate,
      failed,
      already_done: alreadyDone,
      pending
    },
    items,
    ...(pending > 0
      ? { resume_hint: "call again with the same batch_reference and the remaining items" }
      : {})
  };

  return { ok: true, result };
}
