"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";

export function AdminAgentPurgeButton({ disabled }: { disabled: boolean }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function purge() {
    const confirmed = window.confirm(
      "Hard delete archived agent sessions older than 30 days? This also deletes their messages and related rows."
    );
    if (!confirmed) return;

    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/agent-sessions/purge", { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as { purged?: number; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Purge failed.");
      setMessage(`Purged ${payload.purged ?? 0} archived session(s).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Purge failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={purge}
        disabled={disabled || loading}
        className="inline-flex h-10 items-center gap-2 rounded-md border border-red-200 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {loading ? "Purging" : "Purge archived"}
      </button>
      {message ? <div className="text-sm text-muted">{message}</div> : null}
    </div>
  );
}
