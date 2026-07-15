"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Unplug } from "lucide-react";

type ExtensionTokenStatus = {
  configured: boolean;
  token: string | null;
  label: string | null;
  status: string;
  created_at: string | null;
  last_seen_at: string | null;
};

function displayDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function errorText(body: unknown, fallback: string) {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error ? error : fallback;
}

export function SettingsExtensionCard() {
  const [status, setStatus] = useState<ExtensionTokenStatus | null>(null);
  const [label, setLabel] = useState("Aryan Chrome");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generate" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);

  async function refreshStatus() {
    try {
      const response = await fetch("/api/settings/extension/token");
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(errorText(body, "Could not load extension token status."));
        return;
      }
      setStatus(body as ExtensionTokenStatus);
    } catch {
      setMessage("Could not load extension token status.");
    }
  }

  useEffect(() => {
    let canceled = false;

    fetch("/api/settings/extension/token")
      .then(async (response): Promise<{ error: string } | { status: ExtensionTokenStatus }> => {
        const body: unknown = await response.json().catch(() => ({}));
        if (!response.ok) {
          return { error: errorText(body, "Could not load extension token status.") };
        }
        return { status: body as ExtensionTokenStatus };
      })
      .then((result) => {
        if (canceled) return;
        if ("error" in result) setMessage(result.error);
        else setStatus(result.status);
      })
      .catch(() => {
        if (!canceled) setMessage("Could not load extension token status.");
      });

    return () => {
      canceled = true;
    };
  }, []);

  async function generateToken() {
    setBusy("generate");
    setMessage(null);
    try {
      const response = await fetch("/api/settings/extension/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label })
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(errorText(body, "Could not generate extension token."));
        return;
      }
      setStatus(body as ExtensionTokenStatus);
      setMessage("Token generated. Copy it now; it will not be shown again.");
    } catch {
      setMessage("Could not generate extension token.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeToken() {
    setBusy("revoke");
    setMessage(null);
    try {
      const response = await fetch("/api/settings/extension/token", { method: "DELETE" });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(errorText(body, "Could not revoke extension token."));
        return;
      }
      setStatus(body as ExtensionTokenStatus);
      setMessage("Extension token revoked.");
    } catch {
      setMessage("Could not revoke extension token.");
    } finally {
      setBusy(null);
    }
  }

  async function copyToken() {
    if (!status?.token) return;
    await navigator.clipboard.writeText(status.token);
    setCopied(true);
    setMessage("Token copied.");
    window.setTimeout(() => setCopied(false), 1500);
  }

  const isBusy = busy !== null;

  return (
    <section className="rounded-2xl border border-line bg-surface p-4 ">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Chrome extension</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Pair the local extension to claim approved runs from this app.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface px-3 py-2 text-sm">
          {status?.configured ? "Token active" : "Not paired"}
        </div>
      </div>

      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="text-xs uppercase text-muted">Status</div>
          <div className="mt-1 font-medium">{status?.status ?? "Loading"}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="text-xs uppercase text-muted">Label</div>
          <div className="mt-1 font-medium">{status?.label ?? "None"}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="text-xs uppercase text-muted">Last seen</div>
          <div className="mt-1 font-medium">{displayDate(status?.last_seen_at ?? null)}</div>
        </div>
      </div>

      {status?.token ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-3">
          <div className="text-xs font-semibold uppercase text-muted">Token shown once</div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded-xl bg-surface px-3 py-2 text-xs">{status.token}</code>
            <button
              type="button"
              onClick={copyToken}
              className={`inline-flex h-10 min-w-24 items-center justify-center gap-2 rounded-xl border px-3 text-sm transition-colors ${
                copied
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-line text-ink hover:bg-line"
              }`}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block flex-1">
          <span className="text-sm text-muted">Device label</span>
          <input
            className="focus-ring mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={generateToken}
          disabled={isBusy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy === "generate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          {status?.configured ? "Rotate token" : "Generate token"}
        </button>
        <button
          type="button"
          onClick={revokeToken}
          disabled={isBusy || !status?.configured}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-line px-3 text-sm disabled:opacity-50"
        >
          {busy === "revoke" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
          Revoke
        </button>
      </div>

      {message ? <div className="mt-4 text-sm text-muted">{message}</div> : null}
    </section>
  );
}



