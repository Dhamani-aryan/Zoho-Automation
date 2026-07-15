import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { RunStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

type RunsPageProps = {
  searchParams?: Promise<{ sort?: string; dir?: string }>;
};

type RunRow = {
  id: string;
  status: RunStatus;
  run_kind: "read" | "write";
  run_parameters: Record<string, unknown>;
  totals: Record<string, number>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  triggered_by: string | null;
};

function runName(run: RunRow) {
  const value = run.run_parameters.name ?? run.run_parameters.title ?? run.run_parameters.file_name;
  return typeof value === "string" && value.trim() ? value : `${run.run_kind} run`;
}

function durationMs(run: RunRow) {
  const start = run.started_at ? new Date(run.started_at).getTime() : new Date(run.created_at).getTime();
  const end = run.completed_at ? new Date(run.completed_at).getTime() : Date.now();
  return Math.max(0, end - start);
}

function formatDuration(run: RunRow) {
  if (!run.started_at && !run.completed_at) return "";
  const seconds = Math.round(durationMs(run) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function progress(run: RunRow) {
  const totals = run.totals ?? {};
  const done = Number(totals.success ?? 0) + Number(totals.skipped ?? 0) + Number(totals.failed ?? 0);
  const total = Object.values(totals).reduce((sum, value) => sum + Number(value ?? 0), 0);
  return total > 0 ? `${done}/${total}` : "0/0";
}

function sortLink(sort: string, currentSort: string, currentDir: string) {
  const dir = currentSort === sort && currentDir === "asc" ? "desc" : "asc";
  return `/runs?sort=${sort}&dir=${dir}`;
}

function SortHeader({
  sort,
  currentSort,
  currentDir,
  children
}: {
  sort: string;
  currentSort: string;
  currentDir: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={sortLink(sort, currentSort, currentDir)} className="hover:text-ink">
      {children}
    </Link>
  );
}

export default async function RunsPage({ searchParams }: RunsPageProps) {
  const params = (await searchParams) ?? {};
  const currentSort = params.sort ?? "started";
  const currentDir = params.dir === "asc" ? "asc" : "desc";
  const supabase = await createServerSupabaseClient();
  let runs: RunRow[] = [];

  if (supabase) {
    const { data } = await supabase
      .from("workflow_runs")
      .select("id,status,run_kind,run_parameters,totals,started_at,completed_at,created_at,triggered_by")
      .order("created_at", { ascending: false })
      .limit(50);
    runs = (data ?? []) as RunRow[];
  }

  runs.sort((a, b) => {
    const direction = currentDir === "asc" ? 1 : -1;
    const value = (run: RunRow) => {
      if (currentSort === "status") return run.status;
      if (currentSort === "name") return runName(run);
      if (currentSort === "duration") return durationMs(run);
      if (currentSort === "progress") return progress(run);
      if (currentSort === "owner") return run.triggered_by ?? "";
      return run.started_at ?? run.created_at;
    };
    const left = value(a);
    const right = value(b);
    return left > right ? direction : left < right ? -direction : 0;
  });

  return (
    <AppShell>
      <PageHeader
        eyebrow="Reports"
        title="Run history"
        description="Sortable execution history with status, timing, progress, and owner metadata."
      />
      <section className="overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-[0.05em] text-muted">
              <tr>
                <th className="px-4 py-3">
                  <SortHeader sort="status" currentSort={currentSort} currentDir={currentDir}>Status</SortHeader>
                </th>
                <th className="px-4 py-3">
                  <SortHeader sort="name" currentSort={currentSort} currentDir={currentDir}>Name</SortHeader>
                </th>
                <th className="px-4 py-3">
                  <SortHeader sort="started" currentSort={currentSort} currentDir={currentDir}>Started</SortHeader>
                </th>
                <th className="px-4 py-3">
                  <SortHeader sort="duration" currentSort={currentSort} currentDir={currentDir}>Duration</SortHeader>
                </th>
                <th className="px-4 py-3">
                  <SortHeader sort="progress" currentSort={currentSort} currentDir={currentDir}>Progress</SortHeader>
                </th>
                <th className="px-4 py-3">
                  <SortHeader sort="owner" currentSort={currentSort} currentDir={currentDir}>Owner</SortHeader>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-line hover:bg-line">
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/run/${run.id}`} className="font-medium text-ink hover:text-accent">
                      {runName(run)}
                    </Link>
                    <div className="mt-1 font-mono text-xs text-muted">{run.id}</div>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {new Date(run.started_at ?? run.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-muted">{formatDuration(run) || "Not started"}</td>
                  <td className="px-4 py-3 text-muted">{progress(run)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{run.triggered_by?.slice(0, 8) ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runs.length === 0 ? (
          <div className="border-t border-line px-4 py-10 text-sm text-muted">No run history yet.</div>
        ) : null}
      </section>
    </AppShell>
  );
}


