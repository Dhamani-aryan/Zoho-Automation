import { ClipboardList, Database, FileSpreadsheet, ListChecks, MessageSquare, Table2 } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ConnectionBanner } from "@/components/connection-banner";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { getDashboardStats, getRecentChats } from "@/lib/supabase/queries";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [stats, recentChats] = await Promise.all([getDashboardStats(), getRecentChats(3)]);

  return (
    <AppShell>
      <PageHeader
        eyebrow="V2 Agent"
        title="Operations dashboard"
        description="Monitor the local CRM mirror, batch run history, and the V2 agent rollout. Phase A answers from Supabase only; live Zoho reads come next through the extension."
        action={
          <Link
            href="/agent"
            className="inline-flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-white"
          >
            Open agent
          </Link>
        }
      />
      <ConnectionBanner connected={stats.connected} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Accounts" value={stats.accounts} icon={Database} />
        <MetricCard label="Contacts" value={stats.contacts} icon={Table2} />
        <MetricCard label="Deals" value={stats.deals} icon={ListChecks} />
        <MetricCard label="Runs" value={stats.runs} icon={ClipboardList} />
        <MetricCard label="Field meta" value={stats.fieldMeta} icon={FileSpreadsheet} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-md border border-line bg-surface ">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Recent chats</h2>
            <Link href="/agent" className="text-xs font-semibold text-accent hover:underline">
              Open agent
            </Link>
          </div>
          {recentChats.length > 0 ? (
            <ul className="divide-y divide-line">
              {recentChats.map((chat) => (
                <li key={chat.id}>
                  <Link
                    href={`/agent?session=${chat.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-surface"
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {chat.title || "New agent chat"}
                      </div>
                      <div className="text-xs text-muted">
                        {new Date(chat.updated_at).toLocaleString()}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-10 text-sm text-muted">
              No agent chats yet.{" "}
              <Link href="/agent" className="font-semibold text-accent hover:underline">
                Start one
              </Link>
              .
            </div>
          )}
        </section>

        <section className="rounded-md border border-line bg-surface p-4 ">
          <h2 className="text-sm font-semibold">V2 rollout status</h2>
          <div className="mt-4 space-y-3 text-sm">
            {[
              "Phase A: local DB agent tools live",
              "Tool trace visible in /agent",
              "Missing CRM capabilities file tool requests",
              "Phase B next: live Zoho reads through extension",
              "CRM writes still require explicit approval"
            ].map((item) => (
              <div key={item} className="flex items-center gap-3">
                <div className="h-2 w-2 rounded-full bg-accent" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

