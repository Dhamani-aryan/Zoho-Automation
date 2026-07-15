"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Play, Save, Search, Sparkles, TriangleAlert, X } from "lucide-react";

export type SkillGuideParam = { name: string; description: string; example: string };

export type SkillGuideRow = {
  id: string;
  name: string;
  intent: string;
  preconditions: string;
  method_api: string;
  method_ui: string;
  gotchas: string;
  verification: string;
  stop_conditions: string;
  params: SkillGuideParam[] | null;
  version: number;
  updated_at: string;
  created_at: string;
};

const AUTO_TRIGGER_KEYWORDS: Record<string, string[]> = {
  "email-scheduling": ["email", "composer", "schedule", "subject", "recipient", "cc", "signature"],
  "deals-editing": ["deal", "potential", "next step"],
  "contacts-editing": ["contact", "person", "people"],
  "accounts-editing": ["account", "company"]
};

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function methodFor(guide: SkillGuideRow) {
  const api = Boolean(guide.method_api.trim());
  const ui = Boolean(guide.method_ui.trim());
  if (api && ui) return "API + Browser";
  if (api) return "API";
  if (ui) return "Browser";
  return "Guide";
}

function buildPrefill(guide: SkillGuideRow) {
  const params = Array.isArray(guide.params) ? guide.params : [];
  const slots = params.length
    ? params.map((param) => `- ${param.name}: ${param.example ? `[${param.example}]` : "[fill in]"}`).join("\n")
    : "- Request: [describe what to do]";
  return `Run the "${guide.name}" skill guide.\n\nFill these parameters before acting:\n${slots}`;
}

function GuideSection({ label, content }: { label: string; content: string }) {
  if (!content.trim()) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className="whitespace-pre-wrap rounded-xl border border-line bg-canvas p-3 text-sm leading-6 text-ink">
        {content}
      </div>
    </div>
  );
}

function EditField({
  label,
  name,
  defaultValue,
  rows = 3
}: {
  label: string;
  name: string;
  defaultValue: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">{label}</span>
      <textarea
        name={name}
        defaultValue={defaultValue}
        rows={rows}
        className="mt-1 w-full rounded-xl border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

export function SkillsLibrary({
  initialGuides,
  canEdit,
  loadError
}: {
  initialGuides: SkillGuideRow[];
  canEdit: boolean;
  loadError: string | null;
}) {
  const [guides, setGuides] = useState(initialGuides);
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(loadError);

  const filteredGuides = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return guides.filter((guide) => {
      const matchesQuery =
        !needle || guide.name.toLowerCase().includes(needle) || guide.intent.toLowerCase().includes(needle);
      const matchesMethod = method === "all" || methodFor(guide) === method;
      return matchesQuery && matchesMethod;
    });
  }, [guides, method, query]);

  async function saveGuide(event: FormEvent<HTMLFormElement>, guide: SkillGuideRow) {
    event.preventDefault();
    setSavingId(guide.id);
    setError(null);
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get("name") ?? guide.name),
      intent: String(form.get("intent") ?? guide.intent),
      preconditions: String(form.get("preconditions") ?? guide.preconditions),
      method_api: String(form.get("method_api") ?? guide.method_api),
      method_ui: String(form.get("method_ui") ?? guide.method_ui),
      gotchas: String(form.get("gotchas") ?? guide.gotchas),
      verification: String(form.get("verification") ?? guide.verification),
      stop_conditions: String(form.get("stop_conditions") ?? guide.stop_conditions),
      params: guide.params ?? []
    };

    try {
      const response = await fetch(`/api/skill-guides/${guide.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => ({}))) as { guide?: SkillGuideRow; error?: string };
      if (!response.ok || !payload.guide) throw new Error(payload.error ?? "Could not save skill guide.");
      setGuides((current) => current.map((item) => (item.id === guide.id ? payload.guide! : item)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save skill guide.");
    } finally {
      setSavingId(null);
    }
  }

  if (error && guides.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-pending/40 bg-pending/10 p-4 text-sm text-pending">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        Could not load skill guides: {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-xl border border-line bg-canvas pl-9 pr-3 text-sm text-ink outline-none focus:border-accent"
            placeholder="Search name or intent"
          />
        </div>
        <select
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          className="h-10 rounded-xl border border-line bg-canvas px-3 text-sm text-ink outline-none focus:border-accent"
        >
          <option value="all">All methods</option>
          <option value="API">API</option>
          <option value="Browser">Browser</option>
          <option value="API + Browser">API + Browser</option>
        </select>
      </div>

      {filteredGuides.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-8 text-center text-sm text-muted">
          No skill guides match the current filters.
        </div>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-[0.05em] text-muted">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Version</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Auto-trigger</th>
                  <th className="px-4 py-3">Last updated</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredGuides.map((guide) => {
                  const params = Array.isArray(guide.params) ? guide.params : [];
                  const triggers = AUTO_TRIGGER_KEYWORDS[guide.name];
                  const isEditing = editingId === guide.id;
                  return (
                    <tr key={guide.id} className="border-t border-line align-top">
                      <td colSpan={6} className="p-0">
                        <details className="group">
                          <summary className="grid cursor-pointer grid-cols-[minmax(220px,1.4fr)_90px_140px_140px_180px_180px] items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                            <div className="min-w-0">
                              <div className="truncate font-mono font-semibold text-ink">{guide.name}</div>
                              <div className="truncate text-xs text-muted group-open:whitespace-normal">
                                {guide.intent}
                              </div>
                            </div>
                            <div className="text-muted">v{guide.version}</div>
                            <div className="text-muted">{methodFor(guide)}</div>
                            <div>
                              {triggers ? (
                                <span className="inline-flex items-center gap-1 rounded-xl border border-success/40 bg-success/10 px-2 py-1 text-xs text-success">
                                  <Sparkles className="h-3 w-3" />
                                  Yes
                                </span>
                              ) : (
                                <span className="text-muted">No</span>
                              )}
                            </div>
                            <div className="text-xs text-muted">{formatTimestamp(guide.updated_at)}</div>
                            <div className="flex flex-wrap gap-2">
                              <Link
                                href={`/agent?prefill=${encodeURIComponent(buildPrefill(guide))}`}
                                className="inline-flex h-8 items-center gap-1 rounded-xl bg-accent px-2 text-xs font-semibold text-white"
                              >
                                <Play className="h-3.5 w-3.5" />
                                Run
                              </Link>
                              {canEdit ? (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    setEditingId(isEditing ? null : guide.id);
                                  }}
                                  className="inline-flex h-8 items-center gap-1 rounded-xl border border-line px-2 text-xs text-ink hover:bg-line"
                                >
                                  {isEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                                  {isEditing ? "Close" : "Edit"}
                                </button>
                              ) : null}
                            </div>
                          </summary>

                          <div className="border-t border-line p-4">
                            {isEditing ? (
                              <form className="grid gap-3" onSubmit={(event) => saveGuide(event, guide)}>
                                <EditField label="Name" name="name" defaultValue={guide.name} rows={1} />
                                <EditField label="Intent" name="intent" defaultValue={guide.intent} rows={2} />
                                <EditField label="Preconditions" name="preconditions" defaultValue={guide.preconditions} />
                                <EditField label="Browser steps" name="method_ui" defaultValue={guide.method_ui} rows={5} />
                                <EditField label="API steps" name="method_api" defaultValue={guide.method_api} rows={5} />
                                <EditField label="Gotchas" name="gotchas" defaultValue={guide.gotchas} />
                                <EditField label="Verification" name="verification" defaultValue={guide.verification} />
                                <EditField label="Stop conditions" name="stop_conditions" defaultValue={guide.stop_conditions} />
                                <div className="flex justify-end">
                                  <button
                                    type="submit"
                                    disabled={savingId === guide.id}
                                    className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
                                  >
                                    <Save className="h-4 w-4" />
                                    {savingId === guide.id ? "Saving" : "Save changes"}
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <div className="space-y-4">
                                {triggers ? (
                                  <div>
                                    <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                                      Trigger keywords
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                      {triggers.map((keyword) => (
                                        <span
                                          key={keyword}
                                          className="rounded-xl border border-line bg-canvas px-2 py-0.5 text-xs text-ink"
                                        >
                                          {keyword}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                                {params.length > 0 ? (
                                  <div>
                                    <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                                      Parameters
                                    </div>
                                    <div className="overflow-x-auto rounded-xl border border-line">
                                      <table className="w-full text-left text-sm">
                                        <thead className="bg-canvas text-xs uppercase tracking-[0.05em] text-muted">
                                          <tr>
                                            <th className="px-3 py-2">Name</th>
                                            <th className="px-3 py-2">Description</th>
                                            <th className="px-3 py-2">Example</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {params.map((param) => (
                                            <tr key={param.name} className="border-t border-line">
                                              <td className="px-3 py-2 font-mono text-xs text-ink">{param.name}</td>
                                              <td className="px-3 py-2 text-muted">{param.description}</td>
                                              <td className="px-3 py-2 font-mono text-xs text-muted">{param.example}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                ) : null}
                                <GuideSection label="Preconditions" content={guide.preconditions} />
                                <GuideSection label="Browser steps" content={guide.method_ui} />
                                <GuideSection label="API steps" content={guide.method_api} />
                                <GuideSection label="Gotchas" content={guide.gotchas} />
                                <GuideSection label="Verification" content={guide.verification} />
                                <GuideSection label="Stop conditions" content={guide.stop_conditions} />
                                <div className="text-xs text-muted">
                                  v{guide.version}, created {formatTimestamp(guide.created_at)}, updated{" "}
                                  {formatTimestamp(guide.updated_at)}
                                </div>
                              </div>
                            )}
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}


