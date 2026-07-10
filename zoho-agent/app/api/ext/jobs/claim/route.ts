import { NextResponse } from "next/server";
import { ZOHO_CRM_DOMAIN, ZOHO_ORG_ID } from "@/lib/constants";
import { requireExtensionAuth } from "@/lib/extension/auth";
import { isTier2WriteTool, tier2ClaimDecision } from "@/lib/agent/tier2-tools";
import {
  queuedJobExpiryPatch,
  runningJobStalePatch,
  sweepCutoffs
} from "@/lib/agent/sweeps";

type ToolJobRow = {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "expired";
  created_at: string;
  approval_id: string | null;
  task_order_id: string | null;
};

async function sweepStaleJobs(auth: Awaited<ReturnType<typeof requireExtensionAuth>>) {
  if ("error" in auth) return;

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

export async function POST(request: Request) {
  const auth = await requireExtensionAuth(request);
  if ("error" in auth) return auth.error;

  try {
    await sweepStaleJobs(auth);

    const { data: nextJob, error: nextError } = await auth.service
      .from("tool_jobs")
      .select("id,tool_name,args,status,created_at,approval_id,task_order_id")
      .eq("user_id", auth.user.id)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (nextError) {
      return NextResponse.json({ error: nextError.message }, { status: 500 });
    }
    if (!nextJob) {
      return NextResponse.json({ job: null });
    }

    // Belt-and-braces (2 of 3): a Tier-2 API write job is only handed out when
    // its linked approval row exists and is 'approved' or it belongs to an
    // approved task order. Browser/eval/UI jobs are intentionally ungated for
    // watched interactive sessions; API writes keep the exact scoped-linkage
    // rule because they can mutate CRM without visible UI evidence.
    if (isTier2WriteTool(nextJob.tool_name)) {
      let taskOrderApproved = false;
      if (nextJob.task_order_id) {
        const { data: order, error: orderError } = await auth.service
          .from("task_orders")
          .select("status")
          .eq("id", nextJob.task_order_id)
          .eq("user_id", auth.user.id)
          .maybeSingle();
        if (orderError) {
          return NextResponse.json({ error: orderError.message }, { status: 500 });
        }
        taskOrderApproved = (order?.status as string | undefined) === "approved";
      }
      let decision = { claimable: taskOrderApproved, reason: taskOrderApproved ? "approved_task_order" : "no_task_order" };
      if (!taskOrderApproved) {
        const { data: approval, error: approvalError } = await auth.service
          .from("pending_approvals")
          .select("status")
          .eq("id", nextJob.approval_id ?? "")
          .maybeSingle();
        if (approvalError) {
          return NextResponse.json({ error: approvalError.message }, { status: 500 });
        }
        decision = tier2ClaimDecision(
          { tool_name: nextJob.tool_name, approval_id: nextJob.approval_id ?? null },
          (approval?.status as string) ?? null
        );
      }
      if (!decision.claimable) {
        await auth.service
          .from("tool_jobs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: `Refused to run scoped extension job without an approved approval or task order (${decision.reason}).`
          })
          .eq("id", nextJob.id)
          .eq("user_id", auth.user.id)
          .eq("status", "queued");
        return NextResponse.json({ job: null });
      }
    }

    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await auth.service
      .from("tool_jobs")
      .update({ status: "running", claimed_at: claimedAt })
      .eq("id", nextJob.id)
      .eq("user_id", auth.user.id)
      .eq("status", "queued")
      .select("id,tool_name,args,status,created_at,approval_id,task_order_id")
      .maybeSingle();

    if (claimError) {
      return NextResponse.json({ error: claimError.message }, { status: 500 });
    }
    if (!claimed) {
      return NextResponse.json({ job: null, lost_race: true });
    }

    const row = claimed as ToolJobRow;
    return NextResponse.json({
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension job claim failed unexpectedly.";
    console.error("[ext-jobs-claim]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
