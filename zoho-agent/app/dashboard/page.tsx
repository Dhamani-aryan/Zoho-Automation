import { Activity, CheckCircle2, CircleDashed, Database, MessageSquare, XCircle } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ConnectionBanner } from "@/components/connection-banner";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getDashboardStats, getRecentChats, getRecentRuns } from "@/lib/supabase/queries";

export const dynamic = "force-dynamic";

function startOfTodayIso() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString();
}

function totalCount(totals: Record<string, number> | null | undefined) {
  if (!totals) return 0;
  return Object.values(totals).reduce((sum, value) => sum + Number(value ?? 0), 0);
}

export default async function DashboardPage() {
  const [stats, recentChats, recentRuns] = await Promise.all([
    getDashboardStats(),
    getRecentChats(5),
    getRecentRuns()
  ]);
  const supabase = await createServerSupabaseClient();
  const todayIso = startOfTodayIso();
  const [activeRunsResult, completedTodayResult, failedRunsResult] = supabase
    ? await Promise.all([
        supabase.from("workflow_runs").select("id", { count: "exact", head: true }).in("status", ["running", "paused"]),
        supabase
          .from("workflow_runs")
          .select("id", { count: "exact", head: true })
          .eq("status", "completed")
          .gte("completed_at", todayIso),
        supabase.from("workflow_runs").select("id", { count: "exact", head: true }).eq("status", "failed")
      ])
    : [{ count: 0 }, { count: 0 }, { count: 0 }];

  const compactStats = [
    { label: "Active runs", value: activeRunsResult.count ?? 0, icon: CircleDashed },
    { label: "Completed today", value: completedTodayResult.count ?? 0, icon: CheckCircle2 },
    { label: "Failed runs", value: failedRunsResult.count ?? 0, icon: XCircle },
    { label: "Sync count", value: stats.accounts + stats.contacts + stats.deals, icon: Database }
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="V2 Agent"
        title="Operations dashboard"
        description="Current run state, recent execution history, and recent agent activity."
        action={
          <Link
            href="/agent"
            className="inline-flex h-10 items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-white"
          >
            Open agent
          </Link>
        }
      />
      <ConnectionBanner connected={stats.connected} />

      <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {compactStats.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-2xl border border-line bg-surface px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-[0.08em] text-muted">{item.label}</div>
                <Icon className="h-4 w-4 text-accent" />
              </div>
              <div className="mt-2 text-2xl font-semibold">{item.value}</div>
            </div>
          );
        })}
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-2xl border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Recent runs</h2>
            <Link href="/runs" className="text-xs font-semibold text-accent hover:underline">
              View all
            </Link>
          </div>
          {recentRuns.length > 0 ? (
            <div className="overflow-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-canvas text-xs uppercase tracking-[0.05em] text-muted">
                  <tr>
                    <th className="px-4 py-3">Run</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Items</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="border-t border-line">
                      <td className="px-4 py-3 font-mono text-xs">
                        <Link href={`/run/${run.id}`} className="text-accent hover:underline">
                          {run.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="px-4 py-3 text-muted">{totalCount(run.totals)}</td>
                      <td className="px-4 py-3 text-muted">{new Date(run.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-10 text-sm text-muted">No run history yet.</div>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <Activity className="h-4 w-4 text-muted" />
          </div>
          {recentChats.length > 0 ? (
            <ul className="divide-y divide-line">
              {recentChats.map((chat) => (
                <li key={chat.id}>
                  <Link href={`/agent?session=${chat.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-line">
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{chat.title || "New agent chat"}</div>
                      <div className="text-xs text-muted">{new Date(chat.updated_at).toLocaleString()}</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-10 text-sm text-muted">No recent agent activity.</div>
          )}
        </section>
      </div>
    </AppShell>
  );
}


