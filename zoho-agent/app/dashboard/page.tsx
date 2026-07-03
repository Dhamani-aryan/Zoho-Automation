import { ClipboardList, Database, FileSpreadsheet, ListChecks, Table2 } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ConnectionBanner } from "@/components/connection-banner";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDashboardStats, getRecentRuns } from "@/lib/supabase/queries";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [stats, recentRuns] = await Promise.all([getDashboardStats(), getRecentRuns()]);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Foundation"
        title="Operations dashboard"
        description="Phase 1 tracks records, uploads, field metadata, and run history before live Zoho execution is added."
        action={
          <Link
            href="/imports"
            className="inline-flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-white"
          >
            Import data
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
        <section className="rounded-md border border-line bg-white shadow-soft">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Recent runs</h2>
          </div>
          {recentRuns.length > 0 ? (
            <div className="overflow-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-surface text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3">Run</th>
                    <th className="px-4 py-3">Kind</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="border-t border-line">
                      <td className="px-4 py-3 font-mono text-xs">{run.id.slice(0, 8)}</td>
                      <td className="px-4 py-3 capitalize">{run.run_kind}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {new Date(run.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-10 text-sm text-muted">
              No runs yet. The first live executor arrives in Phase 3; Phase 1 can still log
              imports and preview data.
            </div>
          )}
        </section>

        <section className="rounded-md border border-line bg-white p-4 shadow-soft">
          <h2 className="text-sm font-semibold">Phase 1 checklist</h2>
          <div className="mt-4 space-y-3 text-sm">
            {[
              "Create Supabase schema and RLS",
              "Seed action blocks and presets",
              "Import account/contact/deal link CSVs",
              "Paste Zoho field metadata JSON",
              "Deploy to Vercel after local pass"
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
