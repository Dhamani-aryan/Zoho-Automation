import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) {
    return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });
  }

  try {
    const { id } = await params;
    const { data: session, error: sessionError } = await auth.supabase
      .from("agent_sessions")
      .select("id,user_id,status")
      .eq("id", id)
      .single();
    if (sessionError || !session) {
      return NextResponse.json({ error: sessionError?.message ?? "Agent session not found." }, { status: 404 });
    }
    if (session.user_id !== auth.user.id) {
      return NextResponse.json({ error: "You can only stop your own agent chats." }, { status: 403 });
    }

    const nowIso = new Date().toISOString();
    const { data: stoppedOrders, error: orderError } = await service
      .from("task_orders")
      .update({
        status: "failed",
        completed_at: nowIso,
        report: { status: "failed", reason: "Stopped by user." }
      })
      .eq("session_id", id)
      .eq("user_id", auth.user.id)
      .eq("status", "approved")
      .select("id");
    if (orderError) throw orderError;

    const orderIds = ((stoppedOrders ?? []) as Array<{ id: string }>).map((order) => order.id);
    if (orderIds.length > 0) {
      const { error: jobError } = await service
        .from("tool_jobs")
        .update({
          status: "expired",
          completed_at: nowIso,
          error_message: "Task order stopped by user."
        })
        .eq("session_id", id)
        .eq("user_id", auth.user.id)
        .in("task_order_id", orderIds)
        .eq("status", "queued");
      if (jobError) throw jobError;
    }

    await service
      .from("agent_sessions")
      .update({ turn_active_until: null })
      .eq("id", id)
      .eq("user_id", auth.user.id);

    await service.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "task_order_stopped",
      message: "User pressed Stop for an agent task order.",
      metadata: { session_id: id, task_order_ids: orderIds }
    });

    return NextResponse.json({ ok: true, stopped_task_orders: orderIds.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stop failed unexpectedly.";
    console.error("[agent-session-stop]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
