import type { SupabaseClient } from "@supabase/supabase-js";
import {
  crmFieldToColumn,
  MIRROR_MODULES,
  rowToMirrorRecord,
  tagsOf,
  type MirrorModuleKey
} from "@/lib/records/mirror";
import { tier2RecordIds, type PreparedTier2, type Tier2Module } from "@/lib/agent/tier2-tools";

// Orchestrates the approval gate for a validated Tier-2 write: builds the
// before/after summary shown in the card, freezes the immutable snapshot that
// will be executed EXACTLY as approved, inserts the pending_approvals row, and
// provides the loop's wait helpers. Nothing here performs a Zoho write.

export const APPROVAL_POLL_MS = 1000;
export const APPROVAL_WAIT_MS = 15 * 60 * 1000; // 15 min; does not count against the turn budget.
export const APPROVAL_JOB_WAIT_MS = 130 * 1000; // extension job cap (120s) + slack.

const MODULE_KEY: Record<Tier2Module, MirrorModuleKey> = {
  Accounts: "accounts",
  Contacts: "contacts",
  Deals: "deals"
};

function nameField(module: Tier2Module): string {
  if (module === "Accounts") return "Account_Name";
  if (module === "Contacts") return "Full_Name";
  return "Deal_Name";
}

export type ApprovalSummaryRecord = {
  zoho_id: string;
  name: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

// The immutable executed snapshot. Shapes are tool-specific; each carries an
// expected_name per record so the extension can run an identity check before
// writing.
export type Tier2Snapshot =
  | {
      tool_name: "zoho_update_fields";
      module: Tier2Module;
      updates: Array<{ zoho_id: string; expected_name: string | null; fields: Record<string, unknown> }>;
    }
  | {
      tool_name: "zoho_change_owner";
      module: Tier2Module;
      owner: { id: string; name: string };
      records: Array<{ zoho_id: string; expected_name: string | null }>;
    }
  | {
      tool_name: "zoho_add_tags" | "zoho_remove_tags";
      module: Tier2Module;
      tags: string[];
      records: Array<{ zoho_id: string; expected_name: string | null }>;
    };

// Live fetch injected by the loop (backed by the Phase B bridge) so summary
// building can fall back to live Zoho when the mirror is missing a record.
export type LiveRecordFetch = (input: {
  module: Tier2Module;
  zohoIds: string[];
  fields: string[];
}) => Promise<Map<string, ResolvedRecord>>;

export type ResolvedRecord = {
  name: string | null;
  owner: string | null;
  tags: string[];
  get: (apiName: string) => unknown;
};

// Build a ResolvedRecord from a live Zoho record body (used by the loop's
// live-fetch fallback). Keeps Owner/Tag extraction identical to the mirror path.
export function resolvedFromLiveRecord(module: Tier2Module, record: Record<string, unknown>): ResolvedRecord {
  const rawName = record[nameField(module)];
  const tag = record.Tag;
  const tags = Array.isArray(tag)
    ? tag
        .map((entry) =>
          entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
            ? (entry as { name: string }).name
            : typeof entry === "string"
              ? entry
              : null
        )
        .filter((value): value is string => Boolean(value))
    : [];
  return {
    name: typeof rawName === "string" ? rawName : null,
    owner: ownerName(record.Owner),
    tags,
    get: (apiName: string) => record[apiName] ?? null
  };
}

const UNKNOWN = "unknown - verify in card";

function fieldsNeeded(prepared: PreparedTier2): string[] {
  if (prepared.tool_name === "zoho_update_fields") {
    const set = new Set<string>();
    for (const record of prepared.records) for (const key of Object.keys(record.fields)) set.add(key);
    return [...set];
  }
  if (prepared.tool_name === "zoho_change_owner") return ["Owner"];
  return ["Tag"];
}

async function resolveFromMirror(
  supabase: SupabaseClient,
  module: Tier2Module,
  zohoIds: string[]
): Promise<Map<string, ResolvedRecord>> {
  const config = MIRROR_MODULES[MODULE_KEY[module]];
  const out = new Map<string, ResolvedRecord>();
  // Cast to string: config is a union of the three module configs, and passing
  // union literals to supabase-js .from()/.select() explodes the response type.
  const { data, error } = await supabase
    .from(config.table as string)
    .select(config.select as string)
    .in(config.zohoId as string, zohoIds);
  if (error) return out; // treat mirror failure as "not found"; caller falls back.

  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const record = rowToMirrorRecord(MODULE_KEY[module], row);
    if (!record.zoho_id) continue;
    out.set(record.zoho_id, {
      name: record.name || null,
      owner: record.owner ?? ownerName(record.raw.Owner),
      tags: tagsOf(record),
      get: (apiName) => record.raw[apiName] ?? record.data[crmFieldToColumn(apiName)] ?? null
    });
  }
  return out;
}

function ownerName(owner: unknown): string | null {
  if (owner && typeof owner === "object" && typeof (owner as { name?: unknown }).name === "string") {
    return (owner as { name: string }).name;
  }
  return typeof owner === "string" ? owner : null;
}

function beforeFor(prepared: PreparedTier2, zohoId: string, resolved: ResolvedRecord | undefined): Record<string, unknown> {
  if (!resolved) {
    if (prepared.tool_name === "zoho_change_owner") return { Owner: UNKNOWN };
    if (prepared.tool_name === "zoho_update_fields") {
      const record = prepared.records.find((r) => r.zoho_id === zohoId);
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(record?.fields ?? {})) before[key] = UNKNOWN;
      return before;
    }
    return { tags: UNKNOWN };
  }

  if (prepared.tool_name === "zoho_update_fields") {
    const record = prepared.records.find((r) => r.zoho_id === zohoId);
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(record?.fields ?? {})) before[key] = resolved.get(key);
    return before;
  }
  if (prepared.tool_name === "zoho_change_owner") return { Owner: resolved.owner ?? UNKNOWN };
  return { tags: resolved.tags };
}

function afterFor(prepared: PreparedTier2, zohoId: string): Record<string, unknown> {
  if (prepared.tool_name === "zoho_update_fields") {
    const record = prepared.records.find((r) => r.zoho_id === zohoId);
    return { ...(record?.fields ?? {}) };
  }
  if (prepared.tool_name === "zoho_change_owner") return { Owner: prepared.owner.name };
  return prepared.tool_name === "zoho_add_tags" ? { add: prepared.tags } : { remove: prepared.tags };
}

export async function buildApprovalRequest({
  supabase,
  prepared,
  liveFetch
}: {
  supabase: SupabaseClient;
  prepared: PreparedTier2;
  liveFetch?: LiveRecordFetch;
}): Promise<{ summary: ApprovalSummaryRecord[]; snapshot: Tier2Snapshot }> {
  const ids = tier2RecordIds(prepared);
  const resolved = await resolveFromMirror(supabase, prepared.module, ids);

  const missing = ids.filter((id) => !resolved.has(id));
  if (missing.length > 0 && missing.length <= 10 && liveFetch) {
    try {
      const live = await liveFetch({ module: prepared.module, zohoIds: missing, fields: fieldsNeeded(prepared) });
      for (const [id, rec] of live) resolved.set(id, rec);
    } catch {
      // Live fallback is best-effort; unresolved records show "unknown".
    }
  }

  const summary: ApprovalSummaryRecord[] = ids.map((id) => ({
    zoho_id: id,
    name: resolved.get(id)?.name ?? null,
    before: beforeFor(prepared, id, resolved.get(id)),
    after: afterFor(prepared, id)
  }));

  const nameById = new Map(summary.map((row) => [row.zoho_id, row.name] as const));
  const snapshot = buildSnapshot(prepared, nameById);
  return { summary, snapshot };
}

function buildSnapshot(prepared: PreparedTier2, nameById: Map<string, string | null>): Tier2Snapshot {
  if (prepared.tool_name === "zoho_update_fields") {
    return {
      tool_name: "zoho_update_fields",
      module: prepared.module,
      updates: prepared.records.map((record) => ({
        zoho_id: record.zoho_id,
        expected_name: nameById.get(record.zoho_id) ?? null,
        fields: { ...record.fields }
      }))
    };
  }
  if (prepared.tool_name === "zoho_change_owner") {
    return {
      tool_name: "zoho_change_owner",
      module: prepared.module,
      owner: prepared.owner,
      records: prepared.zoho_ids.map((id) => ({ zoho_id: id, expected_name: nameById.get(id) ?? null }))
    };
  }
  return {
    tool_name: prepared.tool_name,
    module: prepared.module,
    tags: prepared.tags,
    records: prepared.zoho_ids.map((id) => ({ zoho_id: id, expected_name: nameById.get(id) ?? null }))
  };
}

export async function createPendingApproval({
  service,
  sessionId,
  userId,
  snapshot,
  summary,
  status = "pending",
  taskOrderId = null
}: {
  service: SupabaseClient;
  sessionId: string;
  userId: string;
  snapshot: Tier2Snapshot;
  summary: ApprovalSummaryRecord[];
  status?: "pending" | "approved";
  taskOrderId?: string | null;
}): Promise<string> {
  const { data, error } = await service
    .from("pending_approvals")
    .insert({
      session_id: sessionId,
      user_id: userId,
      tool_name: snapshot.tool_name,
      args: snapshot,
      summary,
      status,
      decided_at: status === "approved" ? new Date().toISOString() : null,
      task_order_id: taskOrderId
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ApprovalOutcome = "approved" | "rejected" | "expired";

// Polls the approval row until decided or the 15-min wait elapses. On timeout it
// flips the row to expired with a status-guarded update (so a late human
// decision cannot race a write in). Returns the outcome and how long we waited
// (the caller subtracts this from the turn budget).
export async function waitForApprovalOutcome({
  service,
  approvalId,
  userId
}: {
  service: SupabaseClient;
  approvalId: string;
  userId: string;
}): Promise<{ outcome: ApprovalOutcome; waitedMs: number }> {
  const started = Date.now();
  while (Date.now() - started < APPROVAL_WAIT_MS) {
    const { data, error } = await service
      .from("pending_approvals")
      .select("status")
      .eq("id", approvalId)
      .eq("user_id", userId)
      .single();
    if (error) throw error;
    const status = (data as { status: string }).status;
    if (status === "approved" || status === "rejected" || status === "expired") {
      return { outcome: status, waitedMs: Date.now() - started };
    }
    await sleep(APPROVAL_POLL_MS);
  }

  const { data: expiredRow } = await service
    .from("pending_approvals")
    .update({ status: "expired", decided_at: new Date().toISOString() })
    .eq("id", approvalId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (!expiredRow) {
    // A decision landed between our last poll and the expiry flip (the guarded
    // update matched zero rows). Honor the real decision: if it was approved,
    // the approvals route has already enqueued the write job, and reporting
    // "expired" here would let that write execute while the chat claims
    // nothing happened.
    const { data: lateRow } = await service
      .from("pending_approvals")
      .select("status")
      .eq("id", approvalId)
      .eq("user_id", userId)
      .maybeSingle();
    const late = (lateRow as { status: string } | null)?.status;
    if (late === "approved" || late === "rejected") {
      return { outcome: late, waitedMs: Date.now() - started };
    }
  }
  return { outcome: "expired", waitedMs: Date.now() - started };
}

// After approval, the approvals route has enqueued exactly one tool_job linked
// by approval_id. Wait for the extension to execute and report it.
export async function waitForApprovalJob({
  service,
  approvalId,
  userId
}: {
  service: SupabaseClient;
  approvalId: string;
  userId: string;
}): Promise<{ ok: boolean; result: unknown; waitedMs: number }> {
  const started = Date.now();
  while (Date.now() - started < APPROVAL_JOB_WAIT_MS) {
    const { data, error } = await service
      .from("tool_jobs")
      .select("id,status,result,error_message")
      .eq("approval_id", approvalId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    const job = data as { status: string; result: unknown; error_message: string | null } | null;
    if (job) {
      if (job.status === "done") return { ok: true, result: job.result, waitedMs: Date.now() - started };
      if (job.status === "failed" || job.status === "expired") {
        return {
          ok: false,
          result: { error: job.error_message ?? `Write job ended with status ${job.status}.` },
          waitedMs: Date.now() - started
        };
      }
    }
    await sleep(APPROVAL_POLL_MS);
  }
  return {
    ok: false,
    result: { error: "The approved write did not complete before the wait timed out." },
    waitedMs: Date.now() - started
  };
}
