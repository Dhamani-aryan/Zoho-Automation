import type { ExtensionSettings } from "./storage";

export type HandshakeResponse = {
  user: { id: string; name: string; email: string | null };
  approved_runs: Array<{
    id: string;
    status: string;
    item_counts: Record<string, number>;
  }>;
};

export type ClaimResponse = {
  item: null | {
    id: string;
    block_slug: string | null;
    action: string | null;
  };
  run_complete?: boolean;
};

export async function appFetch<T>(
  settings: ExtensionSettings,
  path: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<T> {
  if (!settings.token.trim()) throw new Error("Extension token is missing.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${settings.backendUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${settings.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (!response.ok) {
      throw new Error(typeof body.error === "string" ? body.error : `Request failed with ${response.status}.`);
    }
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function handshake(settings: ExtensionSettings) {
  return appFetch<HandshakeResponse>(settings, "/api/ext/handshake", { method: "POST" });
}

export function claim(settings: ExtensionSettings, runId: string) {
  return appFetch<ClaimResponse>(
    settings,
    "/api/ext/claim",
    { method: "POST", body: JSON.stringify({ run_id: runId }) },
    15000
  );
}

export function reportSkipped(settings: ExtensionSettings, itemId: string) {
  return appFetch<{ ok: boolean; run_status: string }>(
    settings,
    "/api/ext/report",
    {
      method: "POST",
      body: JSON.stringify({
        item_id: itemId,
        status: "skipped",
        verified: true,
        before_data: {},
        after_data: {},
        evidence: { dry_run: true, source: "extension_skeleton" },
        error_message: "Skipped by extension skeleton dry wiring."
      })
    },
    15000
  );
}
