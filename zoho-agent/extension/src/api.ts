import type { ExtensionSettings } from "./storage";

export type HandshakeResponse = {
  user: { id: string; name: string; email: string | null };
  queued_jobs: number;
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

export type ToolJob = {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
  approval_id?: string | null;
  task_order_id?: string | null;
};

export type JobClaimResponse = {
  job: ToolJob | null;
  lost_race?: boolean;
  context?: {
    org_id: string;
    crm_domain: string;
  };
};

export async function appFetch<T>(
  settings: ExtensionSettings,
  path: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<T> {
  if (!settings.token.trim()) throw new Error("Extension token is missing.");
  const url = `${settings.backendUrl.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
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
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs / 1000}s.`);
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Could not reach ${url}. Check that the app is running, Backend URL is correct, and the extension has host permission for that URL.`
      );
    }
    throw error;
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

export function claimJob(settings: ExtensionSettings) {
  return appFetch<JobClaimResponse>(settings, "/api/ext/jobs/claim", { method: "POST" }, 15000);
}

export function reportJobDone(settings: ExtensionSettings, jobId: string, result: unknown) {
  return appFetch<{ ok: boolean }>(
    settings,
    `/api/ext/jobs/${jobId}/report`,
    { method: "POST", body: JSON.stringify({ result }) },
    15000
  );
}

export function reportJobFailed(
  settings: ExtensionSettings,
  jobId: string,
  errorMessage: string,
  errorCode?: string,
  result?: unknown
) {
  return appFetch<{ ok: boolean }>(
    settings,
    `/api/ext/jobs/${jobId}/report`,
    {
      method: "POST",
      body: JSON.stringify({
        error_message: errorMessage,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(result !== undefined ? { result } : {})
      })
    },
    15000
  );
}
