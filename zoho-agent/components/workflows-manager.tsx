"use client";

import { Check, Play, RefreshCw, Save, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type WorkflowParam = {
  name: string;
  description: string;
  example: string;
};

export type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  params: WorkflowParam[];
  steps: Array<Record<string, unknown>>;
  effect: "read" | "write";
  trusted: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type WorkflowResponse = {
  workflow?: WorkflowRow;
  error?: string;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function paramsLabel(params: WorkflowParam[]) {
  if (params.length === 0) return "No params";
  return params.map((param) => param.name).join(", ");
}

function buildRunPhrase(workflow: WorkflowRow, values: Record<string, string>) {
  const params = workflow.params.reduce<Record<string, string>>((acc, param) => {
    acc[param.name] = values[param.name] ?? "";
    return acc;
  }, {});
  return `Run UI workflow "${workflow.name}" with params: ${JSON.stringify(params)}`;
}

function emptyRunValues(workflow: WorkflowRow) {
  return workflow.params.reduce<Record<string, string>>((acc, param) => {
    acc[param.name] = param.example ?? "";
    return acc;
  }, {});
}

function workflowStepLabel(step: Record<string, unknown>, index: number) {
  const type = typeof step.type === "string" ? step.type : "step";
  const target = typeof step.text === "string" ? step.text : typeof step.selector === "string" ? step.selector : "";
  return `${index + 1}. ${type}${target ? ` - ${target}` : ""}`;
}

export function WorkflowsManager({ initialWorkflows }: { initialWorkflows: WorkflowRow[] }) {
  const router = useRouter();
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [selectedId, setSelectedId] = useState(initialWorkflows[0]?.id ?? "");
  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0] ?? null,
    [selectedId, workflows]
  );
  const [editName, setEditName] = useState(selected?.name ?? "");
  const [editDescription, setEditDescription] = useState(selected?.description ?? "");
  const [editParamsText, setEditParamsText] = useState(JSON.stringify(selected?.params ?? [], null, 2));
  const [editStepsText, setEditStepsText] = useState(JSON.stringify(selected?.steps ?? [], null, 2));
  const [runValues, setRunValues] = useState<Record<string, string>>(selected ? emptyRunValues(selected) : {});
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function selectWorkflow(workflow: WorkflowRow) {
    setSelectedId(workflow.id);
    setEditName(workflow.name);
    setEditDescription(workflow.description ?? "");
    setEditParamsText(JSON.stringify(workflow.params ?? [], null, 2));
    setEditStepsText(JSON.stringify(workflow.steps ?? [], null, 2));
    setRunValues(emptyRunValues(workflow));
    setDeleteConfirm("");
    setMessage(null);
    setError(null);
  }

  async function refreshWorkflows() {
    setError(null);
    const response = await fetch("/api/workflows");
    const payload = (await response.json().catch(() => ({}))) as { workflows?: WorkflowRow[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not refresh workflows.");
    setWorkflows(payload.workflows ?? []);
    const next = (payload.workflows ?? []).find((workflow) => workflow.id === selectedId) ?? payload.workflows?.[0] ?? null;
    if (next) selectWorkflow(next);
  }

  async function saveEdits() {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const params = JSON.parse(editParamsText) as unknown;
      const steps = JSON.parse(editStepsText) as unknown;
      const response = await fetch(`/api/workflows/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          description: editDescription,
          params,
          steps
        })
      });
      const payload = (await response.json().catch(() => ({}))) as WorkflowResponse;
      if (!response.ok || !payload.workflow) throw new Error(payload.error ?? "Could not save workflow.");
      setWorkflows((current) =>
        current.map((workflow) => (workflow.id === payload.workflow?.id ? payload.workflow : workflow))
      );
      selectWorkflow(payload.workflow);
      setMessage("Workflow saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save workflow.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteWorkflow() {
    if (!selected || deleting) return;
    setDeleting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/workflows/${selected.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_name: deleteConfirm })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not delete workflow.");
      const remaining = workflows.filter((workflow) => workflow.id !== selected.id);
      setWorkflows(remaining);
      const next = remaining[0] ?? null;
      if (next) {
        selectWorkflow(next);
      } else {
        setSelectedId("");
        setMessage("Workflow deleted.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete workflow.");
    } finally {
      setDeleting(false);
    }
  }

  function runSelectedWorkflow() {
    if (!selected) return;
    const phrase = buildRunPhrase(selected, runValues);
    router.push(`/agent?draft=${encodeURIComponent(phrase)}`);
  }

  if (workflows.length === 0) {
    return (
      <section className="border border-line bg-white p-8 text-sm text-muted">
        No saved UI workflows yet. Teach and save one from the agent chat, then it will appear here.
      </section>
    );
  }

  return (
    <div className="grid min-h-[620px] gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-hidden border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm font-semibold">Saved workflows</div>
          <button
            type="button"
            onClick={() => refreshWorkflows().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not refresh workflows."))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-white hover:bg-surface"
            title="Refresh"
            aria-label="Refresh workflows"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(100vh-15rem)] overflow-y-auto p-2">
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => selectWorkflow(workflow)}
              className={`mb-2 w-full rounded-md border px-3 py-3 text-left ${
                workflow.id === selected?.id ? "border-ink bg-ink text-white" : "border-line bg-white hover:bg-surface"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{workflow.name}</div>
                  <div className={`mt-1 truncate text-xs ${workflow.id === selected?.id ? "text-white/70" : "text-muted"}`}>
                    {paramsLabel(workflow.params ?? [])}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <span className={`rounded-sm px-1.5 py-0.5 text-[11px] ${workflow.effect === "write" ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"}`}>
                    {workflow.effect}
                  </span>
                  <span className={`rounded-sm px-1.5 py-0.5 text-[11px] ${workflow.trusted ? "bg-blue-100 text-blue-800" : "bg-surface text-muted"}`}>
                    {workflow.trusted ? "trusted" : "untrusted"}
                  </span>
                </div>
              </div>
              <div className={`mt-2 text-xs ${workflow.id === selected?.id ? "text-white/70" : "text-muted"}`}>
                v{workflow.version} - updated {formatDate(workflow.updated_at)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0 border border-line bg-white">
        {selected ? (
          <div className="grid gap-6 p-5">
            <div className="flex flex-col gap-3 border-b border-line pb-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-semibold tracking-[0]">{selected.name}</h2>
                  <span className={`rounded-sm px-2 py-1 text-xs ${selected.effect === "write" ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"}`}>
                    {selected.effect}
                  </span>
                  <span className={`rounded-sm px-2 py-1 text-xs ${selected.trusted ? "bg-blue-100 text-blue-800" : "bg-surface text-muted"}`}>
                    {selected.trusted ? "trusted replay" : "untrusted replay"}
                  </span>
                  <span className="rounded-sm bg-surface px-2 py-1 text-xs text-muted">v{selected.version}</span>
                </div>
                <p className="mt-2 text-sm text-muted">{selected.description || "No description."}</p>
              </div>
              <button
                type="button"
                onClick={runSelectedWorkflow}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white hover:bg-black"
              >
                <Play className="h-4 w-4" /> Run in agent
              </button>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
              <div className="space-y-5">
                <section>
                  <div className="mb-2 text-sm font-semibold">Run params</div>
                  <div className="grid gap-3">
                    {selected.params.length === 0 ? (
                      <div className="text-sm text-muted">This workflow has no params.</div>
                    ) : (
                      selected.params.map((param) => (
                        <label key={param.name} className="grid gap-1 text-sm">
                          <span className="font-medium">{param.name}</span>
                          <span className="text-xs text-muted">{param.description}</span>
                          <input
                            value={runValues[param.name] ?? ""}
                            onChange={(event) =>
                              setRunValues((current) => ({ ...current, [param.name]: event.target.value }))
                            }
                            className="h-10 rounded-md border border-line px-3 outline-none focus:border-ink"
                            placeholder={param.example}
                          />
                        </label>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <div className="mb-2 text-sm font-semibold">Steps</div>
                  <div className="divide-y divide-line overflow-hidden border border-line">
                    {selected.steps.map((step, index) => (
                      <details key={index} className="bg-white px-3 py-2">
                        <summary className="cursor-pointer text-sm font-medium">{workflowStepLabel(step, index)}</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap bg-surface p-3 text-xs">
                          {JSON.stringify(step, null, 2)}
                        </pre>
                      </details>
                    ))}
                  </div>
                </section>
              </div>

              <div className="space-y-5">
                <section className="border border-line p-4">
                  <div className="mb-3 text-sm font-semibold">Edit workflow</div>
                  <div className="grid gap-3">
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Name</span>
                      <input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        className="h-10 rounded-md border border-line px-3 outline-none focus:border-ink"
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Description</span>
                      <textarea
                        value={editDescription}
                        onChange={(event) => setEditDescription(event.target.value)}
                        rows={3}
                        className="resize-none rounded-md border border-line px-3 py-2 outline-none focus:border-ink"
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Params JSON</span>
                      <textarea
                        value={editParamsText}
                        onChange={(event) => setEditParamsText(event.target.value)}
                        rows={7}
                        spellCheck={false}
                        className="font-mono resize-y rounded-md border border-line px-3 py-2 text-xs outline-none focus:border-ink"
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Steps JSON</span>
                      <textarea
                        value={editStepsText}
                        onChange={(event) => setEditStepsText(event.target.value)}
                        rows={10}
                        spellCheck={false}
                        className="font-mono resize-y rounded-md border border-line px-3 py-2 text-xs outline-none focus:border-ink"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={saveEdits}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Save className="h-4 w-4" /> Save changes
                    </button>
                  </div>
                </section>

                <section className="border border-red-200 bg-red-50 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-800">
                    <Trash2 className="h-4 w-4" /> Delete workflow
                  </div>
                  <label className="grid gap-1 text-sm text-red-900">
                    <span>Type {selected.name} to confirm.</span>
                    <input
                      value={deleteConfirm}
                      onChange={(event) => setDeleteConfirm(event.target.value)}
                      className="h-10 rounded-md border border-red-200 bg-white px-3 outline-none focus:border-red-500"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={deleting || deleteConfirm !== selected.name}
                    onClick={deleteWorkflow}
                    className="mt-3 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-red-600 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                </section>

                {message ? (
                  <div className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    <Check className="h-4 w-4" /> {message}
                  </div>
                ) : null}
                {error ? (
                  <div className="flex items-center gap-2 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    <X className="h-4 w-4" /> {error}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
