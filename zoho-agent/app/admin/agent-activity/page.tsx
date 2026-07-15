import { AppShell } from "@/components/app-shell";
import { AdminAgentPurgeButton } from "@/components/admin-agent-purge-button";
import { PageHeader } from "@/components/page-header";
import { requirePageRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import Link from "next/link";

const EVENT_TYPES = ["agent_turn", "tool_call", "approval_decided", "ext_job_reported", "mirror_sync"];
const PAGE_SIZE = 25;

type AgentActivityPageProps = {
  searchParams?: Promise<{
    page?: string;
    type?: string;
  }>;
};

type AuditRow = {
  id: string;
  user_id: string | null;
  event_type: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

function isFailure(row: AuditRow) {
  const status = row.metadata?.status;
  const ok = row.metadata?.ok;
  return ok === false || status === "failed" || /^Failed\b/i.test(row.message);
}

function displayUser(row: AuditRow, names: Map<string, string>) {
  return row.user_id ? names.get(row.user_id) ?? row.user_id.slice(0, 8) : "System";
}

function parsePage(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function parseEventType(value: string | undefined) {
  return EVENT_TYPES.includes(value ?? "") ? value ?? "all" : "all";
}

function activityHref(page: number, type: string) {
  const params = new URLSearchParams();
  if (type !== "all") params.set("type", type);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/agent-activity?${query}` : "/admin/agent-activity";
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export default async function AgentActivityPage({ searchParams }: AgentActivityPageProps) {
  await requirePageRole(["admin"]);
  const params = (await searchParams) ?? {};
  const page = parsePage(params.page);
  const selectedType = parseEventType(params.type);
  const from = (page - 1) * PAGE_SIZE;
  const to = page * PAGE_SIZE - 1;
  const service = createServiceSupabaseClient();
  let events: AuditRow[] = [];
  let summaryEvents: AuditRow[] = [];
  let total = 0;
  const userNames = new Map<string, string>();

  if (service) {
    const { data: summaryData } = await service
      .from("audit_events")
      .select("id,user_id,event_type,message,metadata,created_at")
      .in("event_type", EVENT_TYPES)
      .order("created_at", { ascending: false })
      .limit(250);
    summaryEvents = (summaryData ?? []) as AuditRow[];

    let tableQuery = service
      .from("audit_events")
      .select("id,user_id,event_type,message,metadata,created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    tableQuery =
      selectedType === "all"
        ? tableQuery.in("event_type", EVENT_TYPES)
        : tableQuery.eq("event_type", selectedType);
    const { data, count } = await tableQuery;
    events = (data ?? []) as AuditRow[];
    total = count ?? 0;

    const userIds = [
      ...new Set(
        [...summaryEvents, ...events].map((event) => event.user_id).filter((id): id is string => Boolean(id))
      )
    ];
    if (userIds.length > 0) {
      const { data: users } = await service.from("users").select("id,name,email").in("id", userIds);
      for (const user of users ?? []) {
        const id = user.id as string;
        userNames.set(id, String(user.name ?? user.email ?? id));
      }
    }
  }

  const counts = new Map<string, { user: string; total: number; failures: number }>();
  for (const row of summaryEvents) {
    const key = row.user_id ?? "system";
    const current = counts.get(key) ?? { user: displayUser(row, userNames), total: 0, failures: 0 };
    current.total += 1;
    if (isFailure(row)) current.failures += 1;
    counts.set(key, current);
  }

  const latestFailures = summaryEvents.filter(isFailure).slice(0, 8);
  const showingStart = total === 0 || events.length === 0 ? 0 : from + 1;
  const showingEnd = events.length === 0 ? 0 : Math.min(from + events.length, total);
  const hasPrevious = page > 1;
  const hasNext = to + 1 < total;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Admin"
        title="Agent activity"
        description="Recent agent turns, tool calls, approvals, extension reports, and mirror sync activity."
      />

      <section className="mb-6 grid gap-3 md:grid-cols-3">
        {[...counts.values()].slice(0, 6).map((entry) => (
          <div key={entry.user} className="rounded-2xl border border-line bg-surface p-4">
            <div className="truncate text-sm font-medium">{entry.user}</div>
            <div className="mt-2 text-2xl font-semibold">{entry.total}</div>
            <div className="text-xs text-muted">{entry.failures} latest failure(s)</div>
          </div>
        ))}
      </section>

      <section className="mb-6 rounded-2xl border border-line bg-surface p-4">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Archived session retention</h2>
            <p className="mt-1 text-sm text-muted">
              Hard delete archived agent sessions older than 30 days after confirmation.
            </p>
          </div>
          <AdminAgentPurgeButton disabled={false} />
        </div>
      </section>

      <section className="mb-6 rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold">Latest failures</h2>
        <div className="divide-y divide-line">
          {latestFailures.length === 0 ? (
            <div className="py-3 text-sm text-muted">No recent failures in the latest activity window.</div>
          ) : (
            latestFailures.map((row) => (
              <div key={row.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{row.event_type}</span>
                  <span className="text-muted">{displayUser(row, userNames)}</span>
                  <span className="text-xs text-muted">{new Date(row.created_at).toLocaleString()}</span>
                </div>
                <div className="mt-1 text-sm text-ink">{row.message}</div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <div className="flex flex-wrap gap-2">
            <Link
              href={activityHref(1, "all")}
              className={`rounded-xl border px-3 py-2 text-sm ${
                selectedType === "all"
                  ? "border-accent bg-success/10 text-accent"
                  : "border-line bg-surface text-ink"
              }`}
            >
              All
            </Link>
            {EVENT_TYPES.map((type) => (
              <Link
                key={type}
                href={activityHref(1, type)}
                className={`rounded-xl border px-3 py-2 text-sm ${
                  selectedType === type
                    ? "border-accent bg-success/10 text-accent"
                    : "border-line bg-surface text-ink"
                }`}
              >
                {type.replaceAll("_", " ")}
              </Link>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Time</th>
                <th className="py-2 pr-4 font-medium">User</th>
                <th className="py-2 pr-4 font-medium">Event</th>
                <th className="py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap py-1.5 pr-4 text-xs text-muted">{formatTime(row.created_at)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-4 text-xs">{displayUser(row, userNames)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-4 text-xs">{row.event_type}</td>
                  <td className="max-w-xl truncate py-1.5" title={row.message}>
                    {row.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <div>
            Showing {showingStart}-{showingEnd} of {total}
          </div>
          <div className="flex items-center gap-2">
            {hasPrevious ? (
              <Link
                href={activityHref(page - 1, selectedType)}
                className="rounded-xl border border-line px-3 py-2 text-ink hover:bg-line"
              >
                Prev
              </Link>
            ) : (
              <span className="rounded-xl border border-line px-3 py-2 opacity-40">Prev</span>
            )}
            {hasNext ? (
              <Link
                href={activityHref(page + 1, selectedType)}
                className="rounded-xl border border-line px-3 py-2 text-ink hover:bg-line"
              >
                Next
              </Link>
            ) : (
              <span className="rounded-xl border border-line px-3 py-2 opacity-40">Next</span>
            )}
          </div>
        </div>
      </section>
    </AppShell>
  );
}



