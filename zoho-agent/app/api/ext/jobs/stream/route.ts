import { ZOHO_CRM_DOMAIN, ZOHO_ORG_ID } from "@/lib/constants";
import { queuedJobExpiryPatch, runningJobStalePatch, sweepCutoffs } from "@/lib/agent/sweeps";
import { requireExtensionAuth } from "@/lib/extension/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExtensionAuth = Exclude<Awaited<ReturnType<typeof requireExtensionAuth>>, { error: Response }>;

type ToolJobRow = {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
  approval_id: string | null;
  task_order_id: string | null;
};

const encoder = new TextEncoder();
const STREAM_MAX_MS = 55_000;
const CLAIM_POLL_MS = 500;
const HEARTBEAT_MS = 20_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sweepStaleJobs(auth: ExtensionAuth) {
  const cutoffs = sweepCutoffs();

  const { error: queuedError } = await auth.service
    .from("tool_jobs")
    .update(queuedJobExpiryPatch(cutoffs.nowIso))
    .eq("user_id", auth.user.id)
    .eq("status", "queued")
    .lt("created_at", cutoffs.queuedJobBeforeIso);

  if (queuedError) throw queuedError;

  const { error: runningError } = await auth.service
    .from("tool_jobs")
    .update(runningJobStalePatch(cutoffs.nowIso))
    .eq("user_id", auth.user.id)
    .eq("status", "running")
    .lt("claimed_at", cutoffs.runningJobBeforeIso);

  if (runningError) throw runningError;
}

async function claimNextJob(auth: ExtensionAuth) {
  const { data: nextJob, error: nextError } = await auth.service
    .from("tool_jobs")
    .select("id,tool_name,args,status,created_at,approval_id,task_order_id")
    .eq("user_id", auth.user.id)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (nextError) throw nextError;
  if (!nextJob) return null;

  const { data: claimed, error: claimError } = await auth.service
    .from("tool_jobs")
    .update({ status: "running", claimed_at: new Date().toISOString() })
    .eq("id", (nextJob as { id: string }).id)
    .eq("user_id", auth.user.id)
    .eq("status", "queued")
    .select("id,tool_name,args,status,created_at,approval_id,task_order_id")
    .maybeSingle();

  if (claimError) throw claimError;
  return (claimed as ToolJobRow | null) ?? null;
}

function sse(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request) {
  const auth = await requireExtensionAuth(request);
  if ("error" in auth) return auth.error;

  const stream = new ReadableStream({
    async start(controller) {
      let lastHeartbeat = 0;
      const started = Date.now();
      controller.enqueue(sse("ready", { ok: true, transport: "sse", localhost_only: true }));
      try {
        while (Date.now() - started < STREAM_MAX_MS) {
          await sweepStaleJobs(auth);
          const row = await claimNextJob(auth);
          if (row) {
            controller.enqueue(
              sse("job", {
                job: {
                  id: row.id,
                  tool_name: row.tool_name,
                  args: row.args,
                  approval_id: row.approval_id,
                  task_order_id: row.task_order_id
                },
                context: {
                  org_id: ZOHO_ORG_ID,
                  crm_domain: ZOHO_CRM_DOMAIN
                }
              })
            );
            controller.close();
            return;
          }
          if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
            lastHeartbeat = Date.now();
            controller.enqueue(sse("heartbeat", { ok: true }));
          }
          await sleep(CLAIM_POLL_MS);
        }
        controller.enqueue(sse("timeout", { ok: true, job: null }));
      } catch (error) {
        controller.enqueue(sse("error", { error: error instanceof Error ? error.message : "Extension job stream failed." }));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
