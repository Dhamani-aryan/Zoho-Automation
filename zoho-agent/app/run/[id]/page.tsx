import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RunDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  if (!supabase) notFound();

  const { data: run } = await supabase
    .from("workflow_runs")
    .select("id,status,run_kind,approval_required,blocks,run_parameters,totals,created_at,updated_at")
    .eq("id", id)
    .single();

  if (!run) notFound();

  const { data: items } = await supabase
    .from("workflow_run_items")
    .select("id,row_number,record_type,record_key,block_slug,status,action,zoho_url,before_data,after_data,error_message")
    .eq("workflow_run_id", id)
    .order("row_number", { ascending: true });

  const runParameters = run.run_parameters as {
    intent_summary?: string;
    warnings?: string[];
    missing_info?: string[];
  };

  return (
    <AppShell>
      <PageHeader
        eyebrow="Run preview"
        title={runParameters.intent_summary ?? "Workflow run"}
        description={`Created ${new Date(run.created_at).toLocaleString()}`}
        action={
          <Link href="/run/new" className="rounded-md border border-line bg-white px-3 py-2 text-sm">
            New run
          </Link>
        }
      />

      <div className="mb-5 grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-line bg-white p-3 shadow-soft">
          <div className="text-xs uppercase text-muted">Status</div>
          <div className="mt-2">
            <StatusBadge status={run.status} />
          </div>
        </div>
        <div className="rounded-md border border-line bg-white p-3 shadow-soft">
          <div className="text-xs uppercase text-muted">Kind</div>
          <div className="mt-2 font-medium capitalize">{run.run_kind}</div>
        </div>
        <div className="rounded-md border border-line bg-white p-3 shadow-soft">
          <div className="text-xs uppercase text-muted">Approval</div>
          <div className="mt-2 font-medium">{run.approval_required ? "Required" : "Not required"}</div>
        </div>
        <div className="rounded-md border border-line bg-white p-3 shadow-soft">
          <div className="text-xs uppercase text-muted">Items</div>
          <div className="mt-2 font-medium">{items?.length ?? 0}</div>
        </div>
      </div>

      {runParameters.missing_info?.length ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {runParameters.missing_info.join(" ")}
        </div>
      ) : null}

      {runParameters.warnings?.length ? (
        <div className="mb-4 rounded-md border border-line bg-white p-3 text-sm text-muted">
          {runParameters.warnings.join(" ")}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-md border border-line bg-white shadow-soft">
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-surface text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3">Record</th>
                <th className="px-4 py-3">Block</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Before</th>
                <th className="px-4 py-3">After</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Zoho</th>
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((item) => {
                const before = item.before_data as { record_name?: string };
                return (
                  <tr key={item.id} className="border-t border-line align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{before.record_name ?? item.record_key}</div>
                      <div className="font-mono text-xs text-muted">{item.record_key}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{item.block_slug}</td>
                    <td className="max-w-80 px-4 py-3">{item.action}</td>
                    <td className="px-4 py-3">
                      <pre className="max-w-72 overflow-auto whitespace-pre-wrap text-xs">
                        {JSON.stringify(item.before_data, null, 2)}
                      </pre>
                    </td>
                    <td className="px-4 py-3">
                      <pre className="max-w-72 overflow-auto whitespace-pre-wrap text-xs">
                        {JSON.stringify(item.after_data, null, 2)}
                      </pre>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={item.status} />
                      {item.error_message ? <div className="mt-2 text-xs text-danger">{item.error_message}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      {item.zoho_url ? (
                        <a
                          href={item.zoho_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line"
                          aria-label="Open Zoho record"
                        >
                          <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!items?.length ? (
          <div className="border-t border-line px-4 py-10 text-sm text-muted">No preview rows saved.</div>
        ) : null}
      </section>
    </AppShell>
  );
}
