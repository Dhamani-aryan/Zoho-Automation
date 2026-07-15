import { RECORD_MODULES, type RecordModuleKey } from "@/lib/constants";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { DashboardStats, RecentRun, RecordListRow } from "@/lib/types";

async function countRows(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>, table: string) {
  if (!supabase) return 0;
  const { count } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });

  return count ?? 0;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const supabase = await createServerSupabaseClient();
  const connected = Boolean(supabase);

  const [accounts, contacts, deals, runs, fieldMeta] = await Promise.all([
    countRows(supabase, "accounts"),
    countRows(supabase, "contacts"),
    countRows(supabase, "deals"),
    countRows(supabase, "workflow_runs"),
    countRows(supabase, "zoho_field_meta")
  ]);

  return {
    connected,
    accounts,
    contacts,
    deals,
    runs,
    fieldMeta
  };
}

export async function getRecentRuns(): Promise<RecentRun[]> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("workflow_runs")
    .select("id,status,run_kind,created_at,totals")
    .order("created_at", { ascending: false })
    .limit(6);

  if (error || !data) return [];

  return data as RecentRun[];
}

function startOfTodayIso() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString();
}

function sevenDaysAgoIso() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString();
}

async function countAgentRows(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  table: string,
  filters: Array<{ column: string; value: string; operator?: "eq" | "gte" }>
) {
  if (!supabase) return 0;
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  for (const filter of filters) {
    query = filter.operator === "gte" ? query.gte(filter.column, filter.value) : query.eq(filter.column, filter.value);
  }
  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

export async function getAgentDashboardCounts() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return {
      emailsScheduledToday: 0,
      emailsFailedSevenDays: 0,
      activeAgentChats: 0
    };
  }

  const [emailsScheduledToday, emailsFailedSevenDays, activeAgentChats] = await Promise.all([
    countAgentRows(supabase, "email_batch_items", [
      { column: "status", value: "scheduled" },
      { column: "updated_at", value: startOfTodayIso(), operator: "gte" }
    ]),
    countAgentRows(supabase, "email_batch_items", [
      { column: "status", value: "failed" },
      { column: "updated_at", value: sevenDaysAgoIso(), operator: "gte" }
    ]),
    countAgentRows(supabase, "agent_sessions", [{ column: "status", value: "active" }])
  ]);

  return {
    emailsScheduledToday,
    emailsFailedSevenDays,
    activeAgentChats
  };
}

export type RecentScheduledEmail = {
  id: string;
  to_email: string;
  subject: string;
  status: string;
  batch_reference: string;
  schedule_date: string;
  schedule_time: string;
  updated_at: string;
};

export async function getRecentScheduledEmails(limit = 6): Promise<RecentScheduledEmail[]> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("email_batch_items")
    .select("id,to_email,subject,status,batch_reference,schedule_date,schedule_time,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as RecentScheduledEmail[];
}

export type RecentChat = { id: string; title: string | null; updated_at: string };

export async function getRecentChats(limit = 3): Promise<RecentChat[]> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return [];

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("agent_sessions")
    .select("id,title,updated_at")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as RecentChat[];
}

export async function listRecords(
  moduleKey: RecordModuleKey,
  search: string
): Promise<RecordListRow[]> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return [];

  const config = RECORD_MODULES[moduleKey];
  const term = search.trim();

  if (moduleKey === "accounts") {
    let query = supabase
      .from(config.table)
      .select("id,zoho_account_id,zoho_url,account_name,owner,updated_at,website")
      .order("updated_at", { ascending: false })
      .limit(50);

    if (term) query = query.ilike("account_name", `%${term}%`);

    const { data } = await query;
    return (data ?? []).map((row) => ({
      id: row.id,
      zoho_id: row.zoho_account_id,
      name: row.account_name,
      owner: row.owner,
      zoho_url: row.zoho_url,
      updated_at: row.updated_at,
      extra: row.website
    }));
  }

  if (moduleKey === "contacts") {
    let query = supabase
      .from(config.table)
      .select("id,zoho_contact_id,zoho_url,full_name,email,owner,updated_at,title")
      .order("updated_at", { ascending: false })
      .limit(50);

    if (term) query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`);

    const { data } = await query;
    return (data ?? []).map((row) => ({
      id: row.id,
      zoho_id: row.zoho_contact_id,
      name: row.full_name,
      owner: row.owner,
      zoho_url: row.zoho_url,
      updated_at: row.updated_at,
      extra: row.email ?? row.title
    }));
  }

  let query = supabase
    .from(config.table)
    .select("id,zoho_deal_id,zoho_url,deal_name,owner,updated_at,stage,next_step")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (term) query = query.ilike("deal_name", `%${term}%`);

  const { data } = await query;
  return (data ?? []).map((row) => ({
    id: row.id,
    zoho_id: row.zoho_deal_id,
    name: row.deal_name,
    owner: row.owner,
    zoho_url: row.zoho_url,
    updated_at: row.updated_at,
    extra: row.next_step ?? row.stage
  }));
}
