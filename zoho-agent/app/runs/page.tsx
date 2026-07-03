import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getRecentRuns } from "@/lib/supabase/queries";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await getRecentRuns();

  return (
    <AppShell>
      <PageHeader
        eyebrow="Reports"
        title="Run history"
        description="Every workflow run will land here with status, counts, Zoho links, and report downloads."
      />
      <section className="overflow-hidden rounded-md border border-line bg-white shadow-soft">
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-surface text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3">Run ID</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Success</th>
                <th className="px-4 py-3">Skipped</th>
                <th className="px-4 py-3">Failed</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-line">
                  <td className="px-4 py-3 font-mono text-xs">{run.id}</td>
                  <td className="px-4 py-3 capitalize">{run.run_kind}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3">{run.totals?.success ?? 0}</td>
                  <td className="px-4 py-3">{run.totals?.skipped ?? 0}</td>
                  <td className="px-4 py-3">{run.totals?.failed ?? 0}</td>
                  <td className="px-4 py-3 text-muted">
                    {new Date(run.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runs.length === 0 ? (
          <div className="border-t border-line px-4 py-10 text-sm text-muted">
            No run history yet.
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
