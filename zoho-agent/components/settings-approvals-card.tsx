"use client";

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

type ApprovalSettings = {
  approvals_enabled: boolean;
  role: "admin" | "operator";
};

function errorText(body: unknown, fallback: string) {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error ? error : fallback;
}

export function SettingsApprovalsCard() {
  const [settings, setSettings] = useState<ApprovalSettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let canceled = false;
    fetch("/api/settings/approvals")
      .then(async (response): Promise<{ settings: ApprovalSettings } | { error: string }> => {
        const body: unknown = await response.json().catch(() => ({}));
        if (!response.ok) return { error: errorText(body, "Could not load approval settings.") };
        return { settings: body as ApprovalSettings };
      })
      .then((result) => {
        if (canceled) return;
        if ("error" in result) setMessage(result.error);
        else setSettings(result.settings);
      })
      .catch(() => {
        if (!canceled) setMessage("Could not load approval settings.");
      });
    return () => {
      canceled = true;
    };
  }, []);

  async function setApprovalsEnabled(value: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvals_enabled: value })
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(errorText(body, "Could not update approval settings."));
        return;
      }
      setSettings((current) => ({ role: current?.role ?? "admin", approvals_enabled: value }));
      setMessage(value ? "Approval cards are enabled." : "Approval cards are off by default.");
    } catch {
      setMessage("Could not update approval settings.");
    } finally {
      setBusy(false);
    }
  }

  const enabled = settings?.approvals_enabled ?? false;
  const canEdit = settings?.role === "admin";

  return (
    <section className="rounded-md border border-line bg-white p-4 shadow-soft">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Approval gates</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Control whether write, eval, and batch work pause for approval cards before running.
          </p>
        </div>
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
          {enabled ? "Cards enabled" : "Cards off"}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-accent" />
          <div>
            <div className="font-medium">{enabled ? "Manual approval mode" : "Immediate execution mode"}</div>
            <div className="mt-1 text-muted">
              Audits, before values, read-back checks, budgets, stop conditions, and undo evidence still stay on.
            </div>
          </div>
        </div>
        <button
          type="button"
          disabled={!canEdit || busy || !settings}
          onClick={() => setApprovalsEnabled(!enabled)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {enabled ? "Turn cards off" : "Turn cards on"}
        </button>
      </div>

      {message ? <div className="mt-4 text-sm text-muted">{message}</div> : null}
      {!canEdit && settings ? <div className="mt-4 text-sm text-muted">Only admins can change this setting.</div> : null}
    </section>
  );
}
