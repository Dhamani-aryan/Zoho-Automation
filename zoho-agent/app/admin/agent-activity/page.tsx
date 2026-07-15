import { AppShell } from "@/components/app-shell";
import { AdminAgentPurgeButton } from "@/components/admin-agent-purge-button";
import { PageHeader } from "@/components/page-header";
import { requirePageRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const EVENT_TYPES = ["agent_turn", "tool_call", "approval_decided", "ext_job_reported", "mirror_sync"];

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

export default async function AgentActivityPage() {
  await requirePageRole(["admin"]);
  const service = createServiceSupabaseClient();
  let events: AuditRow[] = [];
  const userNames = new Map<string, string>();

  if (service) {
    const { data } = await service
      .from("audit_events")
      .select("id,user_id,event_type,message,metadata,created_at")
      .in("event_type", EVENT_TYPES)
      .order("created_at", { ascending: false })
      .limit(250);
    events = (data ?? []) as AuditRow[];

    const userIds = [...new Set(events.map((event) => event.user_id).filter((id): id is string => Boolean(id)))];
    if (userIds.length > 0) {
      const { data: users } = await service.from("users").select("id,name,email").in("id", userIds);
      for (const user of users ?? []) {
        const id = user.id as string;
        userNames.set(id, String(user.name ?? user.email ?? id));
      }
    }
  }

  const counts = new Map<string, { user: string; total: number; failures: number }>();
  for (const row of events) {
    const key = row.user_id ?? "system";
    const current = counts.get(key) ?? { user: displayUser(row, userNames), total: 0, failures: 0 };
    current.total += 1;
    if (isFailure(row)) current.failures += 1;
    counts.set(key, current);
  }

  const latestFailures = events.filter(isFailure).slice(0, 12);

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
        <h2 className="mb-3 text-sm font-semibold">Recent activity</h2>
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
                  <td className="whitespace-nowrap py-2 pr-4 text-muted">{new Date(row.created_at).toLocaleString()}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{displayUser(row, userNames)}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{row.event_type}</td>
                  <td className="py-2">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}



