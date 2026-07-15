"use client";

import { useState } from "react";
import { DatabaseZap, Loader2 } from "lucide-react";

type FieldMetaResult = {
  module: string;
  rowsReceived: number;
  rowsStored: number;
  stored: boolean;
  sample: Array<{ api_name: string; label: string; data_type?: string }>;
  warning?: string;
};

export function FieldMetaImporter() {
  const [module, setModule] = useState("Deals");
  const [jsonText, setJsonText] = useState("");
  const [result, setResult] = useState<FieldMetaResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    let payload: unknown;
    try {
      payload = JSON.parse(jsonText);
    } catch {
      setLoading(false);
      setError("Paste valid JSON from Zoho settings/fields.");
      return;
    }

    const response = await fetch("/api/admin/field-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module, payload })
    });

    const body = await response.json();
    setLoading(false);

    if (!response.ok) {
      setError(body.error ?? "Import failed.");
      return;
    }

    setResult(body);
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-4 ">
      <form onSubmit={submit} className="space-y-4">
        <label className="block max-w-xs">
          <span className="text-sm font-medium">Module</span>
          <select
            className="focus-ring mt-1 h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm"
            value={module}
            onChange={(event) => setModule(event.target.value)}
          >
            <option>Deals</option>
            <option>Contacts</option>
            <option>Accounts</option>
            <option>Tasks</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Zoho fields JSON</span>
          <textarea
            className="focus-ring mt-1 min-h-80 w-full rounded-xl border border-line bg-surface p-3 font-mono text-xs leading-5"
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
            placeholder='Paste the full response from /crm/v3/settings/fields?module=Deals'
            required
          />
        </label>
        {error ? (
          <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={loading}
          className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <DatabaseZap className="h-4 w-4" aria-hidden="true" />
          )}
          Import metadata
        </button>
      </form>

      {result ? (
        <div className="mt-5 space-y-4">
          {result.warning ? (
            <div className="rounded-xl border border-pending/40 bg-pending/10 px-3 py-2 text-sm text-pending">
              {result.warning}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-line bg-surface p-3">
              <div className="text-xs text-muted">Module</div>
              <div className="mt-1 text-sm font-semibold">{result.module}</div>
            </div>
            <div className="rounded-xl border border-line bg-surface p-3">
              <div className="text-xs text-muted">Fields parsed</div>
              <div className="mt-1 text-sm font-semibold">{result.rowsReceived}</div>
            </div>
            <div className="rounded-xl border border-line bg-surface p-3">
              <div className="text-xs text-muted">Fields stored</div>
              <div className="mt-1 text-sm font-semibold">{result.rowsStored}</div>
            </div>
          </div>
          <div className="overflow-auto rounded-xl border border-line">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-surface text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">API name</th>
                  <th className="px-3 py-2">Label</th>
                  <th className="px-3 py-2">Type</th>
                </tr>
              </thead>
              <tbody>
                {result.sample.map((field) => (
                  <tr key={field.api_name} className="border-t border-line">
                    <td className="px-3 py-2 font-mono text-xs">{field.api_name}</td>
                    <td className="px-3 py-2">{field.label}</td>
                    <td className="px-3 py-2">{field.data_type ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}



