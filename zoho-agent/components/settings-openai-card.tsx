"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, PlugZap, Unplug } from "lucide-react";

type CredentialStatus = {
  connected: boolean;
  kind?: "codex_oauth" | "openai_api_key";
  label?: string | null;
  status?: string;
  account_id?: string | null;
};

type DeviceStart = {
  device_auth_id: string;
  user_code: string;
  verification_uri: string;
  interval: number;
};

export function SettingsOpenAICard() {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // Which action is in flight ("apikey" | "start" | "poll" | "paste" | "disconnect").
  // Per-action so e.g. "Check approval" doesn't spin the paste button too.
  const [busy, setBusy] = useState<string | null>(null);
  const isBusy = busy !== null;

  async function refreshStatus() {
    try {
      const response = await fetch("/api/settings/llm/status");
      if (response.ok) setStatus(await response.json());
    } catch {
      // Non-fatal: keep the last known status.
    }
  }

  // Every mutating call goes through this helper so a network failure or a
  // non-JSON error response can never strand the card in a loading state.
  async function postJson(url: string, payload?: unknown, timeoutMs = 25000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        ...(payload === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      });
      const body: unknown = await response.json().catch(() => ({}));
      return { ok: response.ok, body };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function errorText(body: unknown, fallback: string) {
    const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    return typeof error === "string" && error ? error : fallback;
  }

  function failureText(error: unknown, fallback: string) {
    return error instanceof Error && error.name === "AbortError"
      ? "The request timed out. Try again in a moment."
      : fallback;
  }

  useEffect(() => {
    let canceled = false;

    fetch("/api/settings/llm/status")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!canceled && body) setStatus(body);
      })
      .catch(() => undefined);

    return () => {
      canceled = true;
    };
  }, []);

  async function saveApiKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("apikey");
    setMessage(null);
    try {
      const { ok, body } = await postJson("/api/settings/llm/api-key", { apiKey });
      if (!ok) {
        setMessage(errorText(body, "Could not save API key."));
        return;
      }
      setApiKey("");
      setMessage("API key connected.");
      await refreshStatus();
    } catch (error) {
      setMessage(failureText(error, "Could not save API key."));
    } finally {
      setBusy(null);
    }
  }

  async function startDeviceFlow() {
    setBusy("start");
    setMessage(null);
    try {
      const { ok, body } = await postJson("/api/settings/llm/codex/start");
      if (!ok) {
        setMessage(errorText(body, "Could not start ChatGPT connection."));
        return;
      }
      setDevice(body as DeviceStart);
    } catch (error) {
      setMessage(failureText(error, "Could not start ChatGPT connection."));
    } finally {
      setBusy(null);
    }
  }

  async function pollDeviceFlow() {
    if (!device) return;
    setBusy("poll");
    setMessage(null);
    try {
      const { ok, body } = await postJson("/api/settings/llm/codex/poll", device);
      if (!ok) {
        setMessage(errorText(body, "Still waiting for approval."));
        return;
      }
      setDevice(null);
      setMessage("ChatGPT subscription connected.");
      await refreshStatus();
    } catch (error) {
      setMessage(failureText(error, "Could not check approval. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function savePastedCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("paste");
    setMessage(null);
    try {
      const { ok, body } = await postJson("/api/settings/llm/codex/paste", {
        credential: pasteValue
      });
      if (!ok) {
        setMessage(errorText(body, "Could not connect pasted credential."));
        return;
      }
      setPasteValue("");
      setMessage("ChatGPT subscription connected from pasted credential.");
      await refreshStatus();
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === "AbortError"
          ? "Credential validation timed out. Try again with a fresh auth.json."
          : "Could not connect pasted credential."
      );
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setMessage(null);
    try {
      const { ok, body } = await postJson("/api/settings/llm/disconnect");
      if (!ok) {
        setMessage(errorText(body, "Disconnect failed."));
        return;
      }
      setMessage("Disconnected.");
      await refreshStatus();
    } catch (error) {
      setMessage(failureText(error, "Disconnect failed."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-md border border-line bg-surface p-4 ">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">OpenAI connection</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Connect your own ChatGPT subscription or OpenAI API key. Secrets are encrypted per user.
          </p>
        </div>
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
          {status?.connected
            ? `${status.kind === "codex_oauth" ? "ChatGPT" : "API key"} connected`
            : "Not connected"}
        </div>
      </div>

      {status?.connected ? (
        <div className="mt-4 rounded-md border border-line bg-surface p-3 text-sm">
          <div>Status: {status.status}</div>
          {status.label ? <div>Label: {status.label}</div> : null}
          {status.account_id ? <div>Account: {status.account_id}</div> : null}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-line p-4">
          <h3 className="text-sm font-semibold">ChatGPT subscription</h3>
          <p className="mt-2 text-sm text-muted">Use the device-code flow for hosted apps.</p>
          {device ? (
            <div className="mt-4 space-y-3 text-sm">
              <div className="rounded-md bg-surface p-3">
                Code: <span className="font-mono text-base font-semibold">{device.user_code}</span>
              </div>
              <a
                href={device.verification_uri}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center rounded-md border border-line px-3"
              >
                Open approval page
              </a>
              <button
                type="button"
                onClick={pollDeviceFlow}
                disabled={isBusy}
                className="ml-2 inline-flex h-10 items-center gap-2 rounded-md bg-accent px-3 text-white disabled:opacity-60"
              >
                {busy === "poll" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                Check approval
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startDeviceFlow}
              disabled={isBusy}
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              <PlugZap className="h-4 w-4" />
              Connect ChatGPT
            </button>
          )}

          <form onSubmit={savePastedCredential} className="mt-5 border-t border-line pt-4">
            <h4 className="text-sm font-semibold">Or paste your Codex credential</h4>
            <p className="mt-1 text-xs text-muted">
              Run <code>codex login</code> locally, then paste the contents of{" "}
              <code>~/.codex/auth.json</code> (or just its refresh_token). Stored encrypted and
              auto-refreshed — no device-auth setting needed.
            </p>
            <textarea
              className="focus-ring mt-2 h-24 w-full rounded-md border border-line px-3 py-2 font-mono text-xs"
              value={pasteValue}
              onChange={(event) => setPasteValue(event.target.value)}
              placeholder='{"tokens":{"refresh_token":"rt.1..."}}'
            />
            <button
              type="submit"
              disabled={isBusy || !pasteValue.trim()}
              className="mt-3 inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm font-semibold disabled:opacity-60"
            >
              {busy === "paste" ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Connect from paste
            </button>
          </form>
        </div>

        <form onSubmit={saveApiKey} className="rounded-md border border-line p-4">
          <h3 className="text-sm font-semibold">OpenAI API key</h3>
          <label className="mt-3 block">
            <span className="text-sm text-muted">API key</span>
            <input
              className="focus-ring mt-1 h-10 w-full rounded-md border border-line px-3 text-sm"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
            />
          </label>
          <button
            type="submit"
            disabled={isBusy || !apiKey}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            <KeyRound className="h-4 w-4" />
            Save API key
          </button>
        </form>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        {message ? <div className="text-sm text-muted">{message}</div> : <div />}
        <button
          type="button"
          onClick={disconnect}
          disabled={isBusy || !status?.connected}
          className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm disabled:opacity-50"
        >
          <Unplug className="h-4 w-4" />
          Disconnect
        </button>
      </div>
    </section>
  );
}

