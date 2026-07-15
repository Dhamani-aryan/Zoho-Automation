import { Activity, AlertTriangle, Database, MailCheck, MessageSquare, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ConnectionBanner } from "@/components/connection-banner";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import {
  getAgentDashboardCounts,
  getDashboardStats,
  getRecentChats,
  getRecentScheduledEmails
} from "@/lib/supabase/queries";

export const dynamic = "force-dynamic";

function emailStatusForBadge(status: string) {
  if (status === "scheduled") return "success";
  if (status === "failed") return "error";
  if (status === "pending" || status === "resolving") return "pending";
  if (status === "skipped_duplicate") return "idle";
  return status;
}

export default async function DashboardPage() {
  const [stats, counts, recentChats, recentScheduledEmails] = await Promise.all([
    getDashboardStats(),
    getAgentDashboardCounts(),
    getRecentChats(5),
    getRecentScheduledEmails(6)
  ]);

  const compactStats = [
    { label: "Emails scheduled today", value: counts.emailsScheduledToday, icon: MailCheck },
    {
      label: "Emails failed (7 days)",
      value: counts.emailsFailedSevenDays,
      icon: AlertTriangle,
      danger: counts.emailsFailedSevenDays > 0
    },
    { label: "Active agent chats", value: counts.activeAgentChats, icon: MessagesSquare },
    { label: "CRM records mirrored", value: stats.accounts + stats.contacts + stats.deals, icon: Database }
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="Agent"
        title="Operations dashboard"
        description="Scheduled email activity, agent sessions, and CRM mirror state."
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
                <Icon className={`h-4 w-4 ${item.danger ? "text-danger" : "text-accent"}`} />
              </div>
              <div className={`mt-2 text-2xl font-semibold ${item.danger ? "text-danger" : ""}`}>{item.value}</div>
            </div>
          );
        })}
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-2xl border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Recent scheduled emails</h2>
            <Link href="/agent" className="text-xs font-semibold text-accent hover:underline">
              View all
            </Link>
          </div>
          {recentScheduledEmails.length > 0 ? (
            <div className="overflow-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-canvas text-xs uppercase tracking-[0.05em] text-muted">
                  <tr>
                    <th className="px-4 py-3">To</th>
                    <th className="px-4 py-3">Subject</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Batch</th>
                    <th className="px-4 py-3">When</th>
                  </tr>
                </thead>
                <tbody>
                  {recentScheduledEmails.map((email) => (
                    <tr key={email.id} className="border-t border-line">
                      <td className="px-4 py-3 text-muted">{email.to_email}</td>
                      <td className="max-w-xs truncate px-4 py-3 text-ink" title={email.subject}>
                        {email.subject}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={emailStatusForBadge(email.status)} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted">{email.batch_reference}</td>
                      <td className="px-4 py-3 text-muted">
                        {email.schedule_date} {email.schedule_time}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-10 text-sm text-muted">No scheduled emails yet.</div>
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


