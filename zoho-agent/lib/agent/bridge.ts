import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedUser } from "@/lib/auth/guards";
import type { AgentToolCall } from "@/lib/llm/provider";
import { agentJobTimeoutMs, extensionLiveMs } from "@/lib/agent/runtime-config";

const REALTIME_DELIVERY_TIMEOUT_MS = 1500;
const REALTIME_RECONCILE_MS = 1000;
const deliveryChannels = new WeakMap<
  SupabaseClient,
  Map<string, { channel: RealtimeChannel; ready: Promise<void> }>
>();

type ToolJobStatus = "queued" | "running" | "done" | "failed" | "expired";

type ToolJobRow = {
  id: string;
  status: ToolJobStatus;
  result: unknown;
  error_message: string | null;
  claimed_at: string | null;
};

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

function realtimeChannelName(userId: string) {
  return `tool-jobs:${userId}`;
}

async function subscribe(channel: RealtimeChannel, timeoutMs = REALTIME_DELIVERY_TIMEOUT_MS) {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function deliveryChannelFor(service: SupabaseClient, userId: string) {
  let channels = deliveryChannels.get(service);
  if (!channels) {
    channels = new Map();
    deliveryChannels.set(service, channels);
  }
  const existing = channels.get(userId);
  if (existing) return existing;

  const channel = service.channel(realtimeChannelName(userId), {
    config: { broadcast: { self: false } }
  });
  const ready = subscribe(channel);
  const state = { channel, ready };
  channels.set(userId, state);
  return state;
}

async function publishJobInserted(service: SupabaseClient, userId: string, jobId: string) {
  const { channel, ready } = deliveryChannelFor(service, userId);
  try {
    await ready;
    await channel.send({
      type: "broadcast",
      event: "job_inserted",
      payload: { job_id: jobId, user_id: userId }
    });
  } catch (error) {
    console.warn("[agent-bridge] Realtime job broadcast failed; fallback pickup remains active.", error);
  }
}

async function fetchJob(service: SupabaseClient, jobId: string, userId: string) {
  const { data: job, error } = await service
    .from("tool_jobs")
    .select("id,status,result,error_message,claimed_at")
    .eq("id", jobId)
    .eq("user_id", userId)
    .single();

  if (error) throw error;
  return job as ToolJobRow;
}

function terminalJobResult(row: ToolJobRow) {
  if (row.status === "done") return { done: true as const, result: row.result };
  if (row.status === "failed" || row.status === "expired") {
    return { done: true as const, error: new Error(jobErrorMessage(row)) };
  }
  return { done: false as const };
}

async function waitForJobResult({
  service,
  userId,
  jobId,
  timeoutMs,
  onStatus
}: {
  service: SupabaseClient;
  userId: string;
  jobId: string;
  timeoutMs: number;
  onStatus?: (status: Extract<ToolJobStatus, "queued" | "running">) => void | Promise<void>;
}) {
  let lastStatus: ToolJobStatus = "queued";
  let settled = false;
  let channel: RealtimeChannel | null = null;

  const emitStatus = async (row: ToolJobRow) => {
    if (row.status === lastStatus) return;
    lastStatus = row.status;
    if (row.status === "queued" || row.status === "running") {
      await onStatus?.(row.status);
    }
  };

  try {
    const initial = await fetchJob(service, jobId, userId);
    await emitStatus(initial);
    const initialResult = terminalJobResult(initial);
    if (initialResult.done) {
      if ("error" in initialResult) throw initialResult.error;
      return initialResult.result;
    }

    return await new Promise<unknown>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timeout = setTimeout(async () => {
        try {
          const { data: expired } = await service
            .from("tool_jobs")
            .update({
              status: "expired",
              completed_at: new Date().toISOString(),
              error_message: "Timed out waiting for the Chrome extension to report this job."
            })
            .eq("id", jobId)
            .eq("user_id", userId)
            .in("status", ["queued", "running"])
            .select("id,status,result,error_message,claimed_at")
            .maybeSingle();

          if (expired) {
            const claimedAt = (expired as ToolJobRow).claimed_at;
            finish(() =>
              reject(
                new Error(
                  claimedAt
                    ? "The extension picked this job up but never reported a result. Refresh the crm.zoho.com tab and ask again."
                    : "The extension never picked this job up. Check that the extension toggle is ON in its options page and that a crm.zoho.com tab is open, then ask again."
                )
              )
            );
          } else {
            finish(() =>
              reject(new Error("Zoho tool job finished after the server wait timed out. Ask again to inspect the latest state."))
            );
          }
        } catch (error) {
          finish(() => reject(error));
        }
      }, timeoutMs);

      const reconcile = setTimeout(async () => {
        try {
          const row = await fetchJob(service, jobId, userId);
          await emitStatus(row);
          const result = terminalJobResult(row);
          if (result.done) {
            clearTimeout(timeout);
            finish(() => ("error" in result ? reject(result.error) : resolve(result.result)));
          }
        } catch (error) {
          clearTimeout(timeout);
          finish(() => reject(error));
        }
      }, REALTIME_RECONCILE_MS);

      channel = service
        .channel(`tool-job-result:${jobId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "tool_jobs", filter: `id=eq.${jobId}` },
          async (payload) => {
            const row = payload.new as ToolJobRow;
            if (row.id !== jobId) return;
            try {
              await emitStatus(row);
              const result = terminalJobResult(row);
              if (!result.done) return;
              clearTimeout(timeout);
              clearTimeout(reconcile);
              finish(() => ("error" in result ? reject(result.error) : resolve(result.result)));
            } catch (error) {
              clearTimeout(timeout);
              clearTimeout(reconcile);
              finish(() => reject(error));
            }
          }
        );

      channel.subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          console.warn(`[agent-bridge] Realtime result channel status: ${status}; reconciliation fallback remains active.`);
        }
      });
    });
  } finally {
    if (channel) await service.removeChannel(channel);
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
  const wait = waitForJobResult({ service, userId: user.id, jobId, timeoutMs, onStatus });
  await publishJobInserted(service, user.id, jobId);
  return wait;
}
