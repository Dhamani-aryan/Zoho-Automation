"use client";

import { AlertTriangle, CheckCircle2, FileUp, Loader2, Play, Save } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";

type ParsedPlan = {
  intent_summary: string;
  run_kind: "read" | "write";
  blocks: Array<{ slug: string; config: Record<string, unknown> }>;
  record_selector: {
    mode: string;
    module: string;
    values?: string[];
    filter?: Record<string, unknown>;
  };
  warnings: string[];
  missing_info: string[];
};

type PreviewItem = {
  row_number: number;
  record_type: string;
  record_key: string;
  record_name: string;
  zoho_url: string | null;
  block_slug: string;
  status: string;
  action: string;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  error_message: string | null;
};

type Validation = {
  status: "preview_ready" | "needs_review";
  target_count: number;
  items: PreviewItem[];
  warnings: string[];
  missing_info: string[];
};

type ApiState = {
  plan: ParsedPlan | null;
  validation: Validation | null;
  error: string | null;
};

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function readJson(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "Request failed.");
  return body;
}

export function RunCommandBuilder() {
  const [command, setCommand] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [state, setState] = useState<ApiState>({ plan: null, validation: null, error: null });
  const [busy, setBusy] = useState<"parse" | "validate" | "save" | null>(null);

  async function parseCommand() {
    setBusy("parse");
    setState((current) => ({ ...current, error: null }));
    try {
      const formData = new FormData();
      formData.set("command", command);
      Array.from(files ?? []).forEach((file) => formData.append("files", file));
      const parsed = (await readJson(await fetch("/api/plan/parse", {
        method: "POST",
        body: formData
      }))) as ParsedPlan;
      setState({ plan: parsed, validation: null, error: null });
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Parse failed." }));
    } finally {
      setBusy(null);
    }
  }

  async function validatePlan() {
    if (!state.plan) return;
    setBusy("validate");
    setState((current) => ({ ...current, error: null }));
    try {
      const response = (await readJson(await fetch("/api/plan/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: state.plan })
      }))) as { plan: ParsedPlan; validation: Validation };
      setState({ plan: response.plan, validation: response.validation, error: null });
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Validation failed." }));
    } finally {
      setBusy(null);
    }
  }

  async function saveRun() {
    if (!state.plan || !state.validation) return;
    setBusy("save");
    setState((current) => ({ ...current, error: null }));
    try {
      const response = (await readJson(await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: state.plan, validation: state.validation })
      }))) as { run: { id: string } };
      window.location.href = `/run/${response.run.id}`;
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Run save failed." }));
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <section className="rounded-md border border-line bg-white p-4 shadow-soft">
        <label htmlFor="command" className="text-sm font-semibold">
          Command
        </label>
        <textarea
          id="command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          rows={9}
          className="focus-ring mt-2 w-full resize-y rounded-md border border-line bg-white px-3 py-2 text-sm leading-6"
          placeholder="Update selected deals so Next Step is 3rd Email"
        />
        <label className="mt-4 flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-line bg-surface px-3 py-4 text-center text-sm text-muted">
          <FileUp className="mb-2 h-5 w-5" aria-hidden="true" />
          <span>{files?.length ? `${files.length} file(s) selected` : "Attach CSV or Markdown context"}</span>
          <input
            type="file"
            multiple
            accept=".csv,.tsv,.md,.markdown,.txt"
            className="sr-only"
            onChange={(event) => setFiles(event.target.files)}
          />
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={parseCommand}
            disabled={!command.trim() || busy !== null}
            className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "parse" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Parse
          </button>
          <button
            type="button"
            onClick={validatePlan}
            disabled={!state.plan || busy !== null}
            className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "validate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Validate
          </button>
          <button
            type="button"
            onClick={saveRun}
            disabled={!state.validation || busy !== null}
            className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save preview
          </button>
        </div>
        {state.error ? (
          <div className="mt-4 flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {state.error}
          </div>
        ) : null}
      </section>

      <section className="rounded-md border border-line bg-white shadow-soft">
        <div className="border-b border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Preview</h2>
            {state.validation ? <StatusBadge status={state.validation.status} /> : null}
          </div>
          {state.plan ? <p className="mt-2 text-sm text-muted">{state.plan.intent_summary}</p> : null}
        </div>
        <div className="grid gap-4 p-4">
          {state.plan ? (
            <div className="grid gap-3 text-sm md:grid-cols-3">
              <div className="rounded-md border border-line bg-surface p-3">
                <div className="text-xs uppercase text-muted">Kind</div>
                <div className="mt-1 font-medium capitalize">{state.plan.run_kind}</div>
              </div>
              <div className="rounded-md border border-line bg-surface p-3">
                <div className="text-xs uppercase text-muted">Module</div>
                <div className="mt-1 font-medium capitalize">{state.plan.record_selector.module}</div>
              </div>
              <div className="rounded-md border border-line bg-surface p-3">
                <div className="text-xs uppercase text-muted">Targets</div>
                <div className="mt-1 font-medium">{state.validation?.target_count ?? "Not validated"}</div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-line bg-surface p-6 text-sm text-muted">
              Parsed plans and validation rows appear here.
            </div>
          )}

          {state.validation?.missing_info.length ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {state.validation.missing_info.join(" ")}
            </div>
          ) : null}

          {state.validation ? (
            <div className="overflow-hidden rounded-md border border-line">
              <div className="overflow-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-surface text-xs uppercase text-muted">
                    <tr>
                      <th className="px-3 py-2">Record</th>
                      <th className="px-3 py-2">Block</th>
                      <th className="px-3 py-2">Action</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.validation.items.map((item) => (
                      <tr key={`${item.row_number}-${item.record_key}-${item.block_slug}`} className="border-t border-line">
                        <td className="px-3 py-2">
                          <div className="font-medium">{item.record_name}</div>
                          <div className="font-mono text-xs text-muted">{item.record_key}</div>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{item.block_slug}</td>
                        <td className="px-3 py-2">{item.action}</td>
                        <td className="px-3 py-2">
                          <StatusBadge status={item.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {state.validation.items.length === 0 ? (
                <div className="border-t border-line px-4 py-8 text-sm text-muted">No preview rows.</div>
              ) : null}
            </div>
          ) : null}

          {state.plan ? (
            <details className="rounded-md border border-line bg-surface p-3 text-sm">
              <summary className="cursor-pointer font-medium">Plan JSON</summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs">{formatJson(state.plan)}</pre>
            </details>
          ) : null}
        </div>
      </section>
    </div>
  );
}
