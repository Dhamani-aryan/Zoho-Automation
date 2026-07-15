"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, Pause, Play, RotateCcw, StopCircle, CheckCircle2, Download } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

export type RunDetail = {
  id: string;
  status: string;
  run_kind: "read" | "write";
  approval_required: boolean;
  approved_by?: string | null;
  approved_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  stop_reason?: string | null;
  blocks: unknown;
  run_parameters: {
    intent_summary?: string;
    warnings?: string[];
    missing_info?: string[];
  };
  totals: Record<string, number>;
  created_at: string;
  updated_at: string;
};

export type RunItem = {
  id: string;
  row_number: number | null;
  record_type: string | null;
  record_key: string | null;
  block_slug: string | null;
  status: string;
  action: string | null;
  zoho_url: string | null;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  error_message: string | null;
  attempts?: number | null;
  claimed_at?: string | null;
  executed_at?: string | null;
  verified?: boolean | null;
  evidence?: Record<string, unknown> | null;
};

type RunDetailResponse = {
  run: RunDetail;
  items: RunItem[];
};

function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function canPoll(status: string) {
  return status === "approved" || status === "running" || status === "paused";
}

function errorText(body: unknown, fallback: string) {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error ? error : fallback;
}

async function readJson(response: Response) {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorText(body, "Request failed."));
  return body;
}

export function RunDetailClient({ initialRun, initialItems }: { initialRun: RunDetail; initialItems: RunItem[] }) {
  const [run, setRun] = useState(initialRun);
  const [items, setItems] = useState(initialItems);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "pause" | "resume" | "cancel" | null>(null);

  const refresh = useCallback(async () => {
    const body = (await readJson(await fetch(`/api/runs/${run.id}`))) as RunDetailResponse;
    setRun(body.run);
    setItems(body.items);
  }, [run.id]);

  useEffect(() => {
    if (!canPoll(run.status)) return;
    const interval = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [refresh, run.status]);

  async function mutate(action: "approve" | "pause" | "resume" | "cancel") {
    setBusy(action);
    setMessage(null);
    try {
      await readJson(await fetch(`/api/runs/${run.id}/${action}`, { method: "POST" }));
      await refresh();
      setMessage(`${action[0].toUpperCase()}${action.slice(1)} saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${action} failed.`);
    } finally {
      setBusy(null);
    }
  }

  const totals = useMemo(
    () => ({
      pending: run.totals?.pending ?? items.filter((item) => item.status === "pending").length,
      running: run.totals?.running ?? items.filter((item) => item.status === "running").length,
      success: run.totals?.success ?? 0,
      skipped: run.totals?.skipped ?? 0,
      failed: run.totals?.failed ?? 0,
      needs_review: run.totals?.needs_review ?? 0
    }),
    [items, run.totals]
  );

  const showApprove = run.status === "preview_ready" && run.run_kind === "write" && run.approval_required;
  const showPause = run.status === "running";
  const showResume = run.status === "paused";
  const showCancel = run.status === "approved" || run.status === "running" || run.status === "paused";

  return (
    <>
      <PageHeader
        eyebrow="Run preview"
        title={run.run_parameters.intent_summary ?? "Workflow run"}
        description={`Created ${new Date(run.created_at).toLocaleString()}`}
        action={
          <Link href="/run/new" className="rounded-xl border border-line bg-surface px-3 py-2 text-sm">
            New run
          </Link>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-3 ">
        {showApprove ? (
          <button
            type="button"
            onClick={() => mutate("approve")}
            disabled={busy !== null}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Approve
          </button>
        ) : null}
        {showPause ? (
          <button
            type="button"
            onClick={() => mutate("pause")}
            disabled={busy !== null}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-line px-3 text-sm disabled:opacity-60"
          >
            {busy === "pause" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
            Pause
          </button>
        ) : null}
        {showResume ? (
          <button
            type="button"
            onClick={() => mutate("resume")}
            disabled={busy !== null}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy === "resume" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Resume
          </button>
        ) : null}
        {showCancel ? (
          <button
            type="button"
            onClick={() => mutate("cancel")}
            disabled={busy !== null}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger/40 px-3 text-sm text-danger disabled:opacity-60"
          >
            {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <StopCircle className="h-4 w-4" />}
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => refresh().catch((error) => setMessage(error instanceof Error ? error.message : "Refresh failed."))}
          disabled={busy !== null}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-line px-3 text-sm disabled:opacity-60"
        >
          <RotateCcw className="h-4 w-4" />
          Refresh
        </button>
        {run.status === "completed" ? (
          <a
            href={`/api/runs/${run.id}/report.csv`}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-line px-3 text-sm"
          >
            <Download className="h-4 w-4" />
            CSV
          </a>
        ) : null}
        {message ? <div className="text-sm text-muted">{message}</div> : null}
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-6">
        {[
          { label: "Status", value: <StatusBadge status={run.status} /> },
          { label: "Kind", value: <span className="font-medium capitalize">{run.run_kind}</span> },
          { label: "Pending", value: totals.pending },
          { label: "Running", value: totals.running },
          { label: "Success", value: totals.success },
          { label: "Failed", value: totals.failed }
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-3 ">
            <div className="text-xs uppercase text-muted">{label}</div>
            <div className="mt-2">{value}</div>
          </div>
        ))}
      </div>

      {run.stop_reason ? (
        <div className="mb-4 rounded-xl border border-pending/40 bg-pending/10 p-3 text-sm text-pending">
          {run.stop_reason}
        </div>
      ) : null}

      {run.run_parameters.missing_info?.length ? (
        <div className="mb-4 rounded-xl border border-pending/40 bg-pending/10 p-3 text-sm text-pending">
          {run.run_parameters.missing_info.join(" ")}
        </div>
      ) : null}

      {run.run_parameters.warnings?.length ? (
        <div className="mb-4 rounded-xl border border-line bg-surface p-3 text-sm text-muted">
          {run.run_parameters.warnings.join(" ")}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-line bg-surface ">
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
                <th className="px-4 py-3">Verified</th>
                <th className="px-4 py-3">Zoho</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
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
                      <pre className="max-w-72 overflow-auto whitespace-pre-wrap text-xs">{formatJson(item.before_data)}</pre>
                    </td>
                    <td className="px-4 py-3">
                      <pre className="max-w-72 overflow-auto whitespace-pre-wrap text-xs">{formatJson(item.after_data)}</pre>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={item.status} />
                      {item.error_message ? <div className="mt-2 text-xs text-danger">{item.error_message}</div> : null}
                    </td>
                    <td className="px-4 py-3">{item.verified == null ? "Not run" : item.verified ? "Yes" : "No"}</td>
                    <td className="px-4 py-3">
                      {item.zoho_url ? (
                        <a
                          href={item.zoho_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line"
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
        {items.length === 0 ? (
          <div className="border-t border-line px-4 py-10 text-sm text-muted">No preview rows saved.</div>
        ) : null}
      </section>
    </>
  );
}



