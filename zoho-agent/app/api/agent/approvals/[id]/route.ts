import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { assertTier2JobInsertAllowed } from "@/lib/agent/tier2-tools";

type DecisionBody = { decision?: unknown };

// POST /api/agent/approvals/:id  { decision: "approve" | "reject" }
// - session-authenticated; only the approval's own user may decide it
// - the flip is an atomic status-guarded update (pending -> approved|rejected)
// - on approve for CRM write tools this is the ONE place a Tier-2 write
//   tool_job is created, always carrying approval_id
//   (assertTier2JobInsertAllowed enforces it)
// - save_ui_workflow and task_order approvals are local confirmations; they do
//   not enqueue an extension job. The waiting agent loop performs the local
//   upsert or begins the task-order scope.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) {
    return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as DecisionBody | null;
  const decision = body?.decision === "approve" || body?.decision === "reject" ? body.decision : null;
  if (!decision) {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'." }, { status: 400 });
  }

  try {
    // Load the approval and confirm it belongs to the caller.
    const { data: approval, error: loadError } = await service
      .from("pending_approvals")
      .select("id,session_id,user_id,tool_name,args,status")
      .eq("id", id)
      .maybeSingle();

    if (loadError) throw loadError;
    if (!approval) {
      return NextResponse.json({ error: "Approval not found." }, { status: 404 });
    }
    if (approval.user_id !== auth.user.id) {
      return NextResponse.json({ error: "You can only decide your own approvals." }, { status: 403 });
    }

    const nextStatus = decision === "approve" ? "approved" : "rejected";

    // Atomic guarded flip: only transitions from pending. A second decision, or
    // a decision after expiry, updates zero rows and is rejected here.
    const { data: decided, error: decideError } = await service
      .from("pending_approvals")
      .update({ status: nextStatus, decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", auth.user.id)
      .eq("status", "pending")
      .select("id,session_id,user_id,tool_name,args,status")
      .maybeSingle();

    if (decideError) throw decideError;
    if (!decided) {
      return NextResponse.json(
        { error: "This approval is no longer pending (already decided or expired)." },
        { status: 409 }
      );
    }

    await service.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "approval_decided",
      message: `Approval ${decision === "approve" ? "approved" : "rejected"} for ${decided.tool_name}.`,
      metadata: { approval_id: id, session_id: decided.session_id, tool_name: decided.tool_name, decision }
    });

    if (decided.tool_name === "task_order") {
      const taskOrderId = (decided.args as { task_order_id?: unknown } | null)?.task_order_id;
      if (typeof taskOrderId !== "string") {
        return NextResponse.json({ error: "Task order approval is missing task_order_id." }, { status: 400 });
      }
      const { error: orderError } = await service
        .from("task_orders")
        .update({
          status: decision === "approve" ? "approved" : "rejected",
          decided_at: new Date().toISOString()
        })
        .eq("id", taskOrderId)
        .eq("user_id", auth.user.id)
        .eq("status", "proposed");
      if (orderError) throw orderError;
    }

    if (decision === "approve" && decided.tool_name !== "save_ui_workflow" && decided.tool_name !== "task_order") {
      // The immutable approved snapshot is executed EXACTLY as approved.
      assertTier2JobInsertAllowed(decided.tool_name as string, id);
      const { error: jobError } = await service.from("tool_jobs").insert({
        session_id: decided.session_id,
        user_id: decided.user_id,
        tool_name: decided.tool_name,
        args: decided.args,
        approval_id: id
      });
      if (jobError) throw jobError;
    }

    return NextResponse.json({ ok: true, status: nextStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval decision failed unexpectedly.";
    console.error("[agent-approval-decision]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
