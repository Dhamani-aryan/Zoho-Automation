import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const nonEmpty = z.string().trim().min(1);
const optionalIdentity = z.string().trim().optional().default("");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const scheduleTime = z
  .string()
  .trim()
  .regex(/^(?:0?\d|1[0-2]):[0-5]\d\s*(?:AM|PM)$|^(?:[01]?\d|2[0-3]):[0-5]\d$/i, "Use HH:MM AM/PM or 24-hour HH:MM.");

export const emailScheduleItemSchema = z
  .object({
    reference: nonEmpty.max(200),
    contact_name: optionalIdentity,
    company: optionalIdentity,
    job_title: optionalIdentity,
    deal_name: optionalIdentity,
    deal_url: z.string().trim().url().optional().or(z.literal("")),
    to: z.string().trim().email().optional().or(z.literal("")),
    cc: z.array(z.string().trim().email()).max(10).default([]),
    subject: nonEmpty.max(500),
    body: nonEmpty.max(50_000),
    schedule_date: isoDate,
    schedule_time: scheduleTime,
    timezone: nonEmpty.max(100).default("Asia/Kolkata"),
    preserve_signature: z.literal(true).default(true)
  })
  .refine((item) => Boolean(item.to || item.contact_name || item.deal_url || item.deal_name), {
    message: "Provide a recipient email, contact name, deal URL, or deal name."
  });

export const scheduleZohoEmailBatchSchema = z.object({
  emails: z.array(emailScheduleItemSchema).min(1).max(100)
});

export type EmailScheduleItem = z.infer<typeof emailScheduleItemSchema>;
export type ScheduleZohoEmailBatchArgs = z.infer<typeof scheduleZohoEmailBatchSchema>;

export type ResolvedEmailScheduleItem = EmailScheduleItem & {
  contact_id: string;
  contact_zoho_id: string;
  contact_name: string;
  account_id: string | null;
  account_name: string | null;
  deal_id: string;
  deal_zoho_id: string;
  deal_name: string;
  deal_url: string;
  to: string;
};

export type EmailResolutionResult =
  | { ok: true; item: ResolvedEmailScheduleItem }
  | { ok: false; reference: string; error: string; candidates?: string[] };

export const EMAIL_SCHEDULING_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "schedule_zoho_email_batch",
    tier: 2,
    description:
      "Deterministically resolve and schedule 1-100 Zoho emails without model calls between records. Use this for structured email drafts instead of browser_eval/ui_step. Blank CC means no CC. Each email is resolved to one Contact and related Deal, composed above the existing signature, scheduled (never sent immediately), and verified independently. More than 3 records requires an active task order.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["emails"],
      properties: {
        emails: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "reference",
              "subject",
              "body",
              "schedule_date",
              "schedule_time",
              "timezone",
              "preserve_signature"
            ],
            properties: {
              reference: { type: "string" },
              contact_name: { type: "string" },
              company: { type: "string" },
              job_title: { type: "string" },
              deal_name: { type: "string" },
              deal_url: { type: "string" },
              to: { type: "string" },
              cc: { type: "array", maxItems: 10, items: { type: "string" } },
              subject: { type: "string" },
              body: { type: "string" },
              schedule_date: { type: "string", description: "YYYY-MM-DD" },
              schedule_time: { type: "string", description: "HH:MM AM/PM or 24-hour HH:MM" },
              timezone: { type: "string" },
              preserve_signature: { const: true }
            }
          }
        }
      }
    }
  }
];

export function isEmailSchedulingTool(name: string) {
  return name === "schedule_zoho_email_batch";
}

export function validateEmailSchedulingToolCall(call: AgentToolCall) {
  if (!isEmailSchedulingTool(call.name)) throw new Error(`Unknown email scheduling tool: ${call.name}`);
  return { ...call, args: scheduleZohoEmailBatchSchema.parse(call.args) };
}

function normalized(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryFragment(value: string) {
  return value.replace(/[%_,()]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string) {
  return new Set(normalized(value).split(" ").filter((token) => token.length > 1));
}

function identityScore(expected: string, actual: string) {
  const left = normalized(expected);
  const right = normalized(actual);
  if (!left) return 0;
  if (left === right) return 20;
  if (right.startsWith(`${left} `) || left.startsWith(`${right} `)) return 12;
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap * 3;
}

function uniqueBest<T>(rows: T[], score: (row: T) => number) {
  const ranked = rows.map((row) => ({ row, score: score(row) })).sort((a, b) => b.score - a.score);
  if (ranked.length === 0 || ranked[0].score <= 0) return { row: null as T | null, ambiguous: false };
  if (ranked.length > 1 && ranked[1].score === ranked[0].score) return { row: null as T | null, ambiguous: true };
  return { row: ranked[0].row, ambiguous: false };
}

type ContactRow = {
  id: string;
  zoho_contact_id: string | null;
  full_name: string;
  email: string | null;
  title: string | null;
  account_id: string | null;
};

type AccountRow = { id: string; account_name: string };
type DealRow = {
  id: string;
  zoho_deal_id: string | null;
  zoho_url: string | null;
  deal_name: string;
  account_id: string | null;
  primary_contact_id: string | null;
};

async function contactCandidates(service: SupabaseClient, item: EmailScheduleItem) {
  if (item.to) {
    const { data, error } = await service
      .from("contacts")
      .select("id,zoho_contact_id,full_name,email,title,account_id")
      .ilike("email", item.to)
      .limit(10);
    if (error) throw error;
    return (data ?? []) as ContactRow[];
  }
  const name = queryFragment(item.contact_name);
  if (!name) return [];
  const { data, error } = await service
    .from("contacts")
    .select("id,zoho_contact_id,full_name,email,title,account_id")
    .ilike("full_name", `%${name}%`)
    .limit(20);
  if (error) throw error;
  return (data ?? []) as ContactRow[];
}

async function accountsById(service: SupabaseClient, ids: string[]) {
  if (ids.length === 0) return new Map<string, AccountRow>();
  const { data, error } = await service.from("accounts").select("id,account_name").in("id", ids);
  if (error) throw error;
  return new Map(((data ?? []) as AccountRow[]).map((row) => [row.id, row]));
}

async function dealCandidates(service: SupabaseClient, item: EmailScheduleItem, contact: ContactRow) {
  let query = service
    .from("deals")
    .select("id,zoho_deal_id,zoho_url,deal_name,account_id,primary_contact_id")
    .limit(30);
  if (item.deal_url) {
    query = query.eq("zoho_url", item.deal_url);
  } else if (contact.id) {
    query = query.eq("primary_contact_id", contact.id);
  } else if (contact.account_id) {
    query = query.eq("account_id", contact.account_id);
  } else if (item.deal_name) {
    const first = queryFragment(item.deal_name).split(" ")[0];
    query = query.ilike("deal_name", `%${first}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  let rows = (data ?? []) as DealRow[];
  if (rows.length === 0 && contact.account_id) {
    const fallback = await service
      .from("deals")
      .select("id,zoho_deal_id,zoho_url,deal_name,account_id,primary_contact_id")
      .eq("account_id", contact.account_id)
      .limit(30);
    if (fallback.error) throw fallback.error;
    rows = (fallback.data ?? []) as DealRow[];
  }
  return rows;
}

export async function resolveEmailScheduleBatch(
  service: SupabaseClient,
  input: ScheduleZohoEmailBatchArgs
): Promise<EmailResolutionResult[]> {
  const output: EmailResolutionResult[] = [];
  for (const item of input.emails) {
    const contacts = await contactCandidates(service, item);
    const accountIds = [...new Set(contacts.map((row) => row.account_id).filter((id): id is string => Boolean(id)))];
    const accountMap = await accountsById(service, accountIds);
    const selectedContact = uniqueBest(contacts, (contact) => {
      const account = contact.account_id ? accountMap.get(contact.account_id) : null;
      return (
        (item.to && contact.email?.toLowerCase() === item.to.toLowerCase() ? 50 : 0) +
        identityScore(item.contact_name, contact.full_name) +
        identityScore(item.company, account?.account_name ?? "") +
        identityScore(item.job_title, contact.title ?? "")
      );
    });
    if (!selectedContact.row) {
      output.push({
        ok: false,
        reference: item.reference,
        error: selectedContact.ambiguous ? "Contact identity is ambiguous." : "No matching contact was found.",
        candidates: contacts.map((row) => `${row.full_name}${row.email ? ` <${row.email}>` : ""}`)
      });
      continue;
    }

    const contact = selectedContact.row;
    if (!contact.email || !contact.zoho_contact_id) {
      output.push({ ok: false, reference: item.reference, error: "The resolved contact is missing a live Zoho id or email." });
      continue;
    }
    const deals = await dealCandidates(service, item, contact);
    const selectedDeal = uniqueBest(deals, (deal) => {
      return (
        (item.deal_url && deal.zoho_url === item.deal_url ? 100 : 0) +
        (deal.primary_contact_id === contact.id ? 30 : 0) +
        (contact.account_id && deal.account_id === contact.account_id ? 10 : 0) +
        identityScore(item.deal_name, deal.deal_name)
      );
    });
    if (!selectedDeal.row) {
      output.push({
        ok: false,
        reference: item.reference,
        error: selectedDeal.ambiguous ? "Related deal identity is ambiguous." : "No related deal was found.",
        candidates: deals.map((row) => row.deal_name)
      });
      continue;
    }
    const deal = selectedDeal.row;
    if (!deal.zoho_deal_id || !deal.zoho_url) {
      output.push({ ok: false, reference: item.reference, error: "The resolved deal is missing a live Zoho id or URL." });
      continue;
    }
    const account = contact.account_id ? accountMap.get(contact.account_id) ?? null : null;
    output.push({
      ok: true,
      item: {
        ...item,
        contact_id: contact.id,
        contact_zoho_id: contact.zoho_contact_id,
        contact_name: contact.full_name,
        account_id: contact.account_id,
        account_name: account?.account_name ?? null,
        deal_id: deal.id,
        deal_zoho_id: deal.zoho_deal_id,
        deal_name: deal.deal_name,
        deal_url: deal.zoho_url,
        to: contact.email
      }
    });
  }
  return output;
}
