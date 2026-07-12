import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedUser } from "@/lib/auth/guards";
import type { AgentToolCall } from "@/lib/llm/provider";
import { assertTier2JobInsertAllowed } from "@/lib/agent/tier2-tools";
import { agentJobTimeoutMs, extensionLiveMs } from "@/lib/agent/runtime-config";

const POLL_INTERVAL_MS = 500;

type ToolJobStatus = "queued" | "running" | "done" | "failed" | "expired";

type ToolJobRow = {
  id: string;
  status: ToolJobStatus;
  result: unknown;
  error_message: string | null;
  claimed_at: string | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loggedOutMessage() {
  return "Zoho appears to be logged out in Chrome. Open crm.zoho.com, sign back in, then ask again.";
}

function jobErrorMessage(job: ToolJobRow) {
  const result = job.result as { error_code?: unknown; error_message?: unknown } | null;
  if (result?.error_code === "zoho_logged_out" || job.error_message === "zoho_logged_out") {
    return loggedOutMessage();
  }
  return (
    job.error_message ??
    (typeof result?.error_message === "string" ? result.error_message : null) ??
    `Zoho tool job ended with status ${job.status}.`
  );
}

async function assertExtensionLive(service: SupabaseClient, userId: string) {
  const liveAfter = new Date(Date.now() - extensionLiveMs()).toISOString();
  const { data, error } = await service
    .from("user_extension_tokens")
    .select("last_seen_at,status")
    .eq("user_id", userId)
    .eq("status", "active")
    .gte("last_seen_at", liveAfter)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error(
      "The Chrome extension is not connected. Open a crm.zoho.com tab and enable the extension, then ask again."
    );
  }
}

export async function runBridgedTool({
  service,
  user,
  sessionId,
  call,
  taskOrderId,
  timeoutMs = agentJobTimeoutMs(),
  onStatus
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  taskOrderId?: string | null;
  timeoutMs?: number;
  onStatus?: (status: Extract<ToolJobStatus, "queued" | "running">) => void | Promise<void>;
}) {
  await assertExtensionLive(service, user.id);

  // Belt-and-braces (1 of 3): the bridge only queues Tier-1 reads. A Tier-2
  // write can never be queued here (it would lack an approval_id); Tier-2 jobs
  // are created solely by the approvals route.
  assertTier2JobInsertAllowed(call.name, null);

  const { data: inserted, error: insertError } = await service
    .from("tool_jobs")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      tool_name: call.name,
      args: call.args,
      ...(taskOrderId ? { task_order_id: taskOrderId } : {})
    })
    .select("id,status,result,error_message,claimed_at")
    .single();

  if (insertError) throw insertError;
  await onStatus?.("queued");

  const jobId = (inserted as ToolJobRow).id;
  const started = Date.now();
  let lastStatus: ToolJobStatus = "queued";

  while (Date.now() - started < timeoutMs) {
    const { data: job, error } = await service
      .from("tool_jobs")
      .select("id,status,result,error_message,claimed_at")
      .eq("id", jobId)
      .eq("user_id", user.id)
      .single();

    if (error) throw error;
    const row = job as ToolJobRow;
    if (row.status !== lastStatus) {
      lastStatus = row.status;
      if (row.status === "queued" || row.status === "running") {
        await onStatus?.(row.status);
      }
    }

    if (row.status === "done") return row.result;
    if (row.status === "failed" || row.status === "expired") {
      throw new Error(jobErrorMessage(row));
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const { data: expired } = await service
    .from("tool_jobs")
    .update({
      status: "expired",
      completed_at: new Date().toISOString(),
      error_message: "Timed out waiting for the Chrome extension to report this job."
    })
    .eq("id", jobId)
    .eq("user_id", user.id)
    .in("status", ["queued", "running"])
    .select("id,status,result,error_message,claimed_at")
    .maybeSingle();

  if (expired) {
    // Tailor the timeout by how far the job got — "never claimed" vs
    // "claimed but never reported" point at different user fixes.
    const claimedAt = (expired as ToolJobRow).claimed_at;
    throw new Error(
      claimedAt
        ? "The extension picked this job up but never reported a result. Refresh the crm.zoho.com tab and ask again."
        : "The extension never picked this job up. Check that the extension toggle is ON in its options page and that a crm.zoho.com tab is open, then ask again."
    );
  }

  throw new Error("Zoho tool job finished after the server wait timed out. Ask again to inspect the latest state.");
}
