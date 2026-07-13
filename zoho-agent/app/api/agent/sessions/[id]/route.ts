import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  queuedJobExpiryPatch,
  sweepCutoffs
} from "@/lib/agent/sweeps";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const { data: session, error: sessionError } = await auth.supabase
      .from("agent_sessions")
      .select("id,title,status,teach_mode,created_at,updated_at")
      .eq("id", id)
      .single();

    if (sessionError || !session) {
      return NextResponse.json({ error: sessionError?.message ?? "Agent session not found." }, { status: 404 });
    }

    const { data: messages, error: messagesError } = await auth.supabase
      .from("agent_messages")
      .select("id,role,content,tool_name,tool_args,tool_result,tool_tier,created_at")
      .eq("session_id", id)
      .order("created_at", { ascending: true });

    if (messagesError) throw messagesError;

    // Expiry sweep on load (status-guarded, owner-scoped): expire old
    // unclaimed jobs before we read the session back.
    const service = createServiceSupabaseClient();
    if (service) {
      const cutoffs = sweepCutoffs();
      const { error: jobSweepError } = await service
        .from("tool_jobs")
        .update(queuedJobExpiryPatch(cutoffs.nowIso))
        .eq("session_id", id)
        .eq("user_id", auth.user.id)
        .eq("status", "queued")
        .lt("created_at", cutoffs.queuedJobBeforeIso);
      if (jobSweepError) throw jobSweepError;
    }

    return NextResponse.json({ session, messages: messages ?? [], approvals: [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent session failed to load.";
    console.error("[agent-session-detail]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { teach_mode?: unknown } | null;
    if (typeof body?.teach_mode !== "boolean") {
      return NextResponse.json({ error: "teach_mode boolean is required." }, { status: 400 });
    }

    const { data: session, error: sessionError } = await auth.supabase
      .from("agent_sessions")
      .select("id,user_id,status")
      .eq("id", id)
      .single();

    if (sessionError || !session) {
      return NextResponse.json({ error: sessionError?.message ?? "Agent session not found." }, { status: 404 });
    }
    if (session.user_id !== auth.user.id) {
      return NextResponse.json({ error: "You can only update your own agent chats." }, { status: 403 });
    }
    if (session.status !== "active") {
      return NextResponse.json({ error: "This agent session is archived." }, { status: 409 });
    }

    const { data, error } = await auth.supabase
      .from("agent_sessions")
      .update({ teach_mode: body.teach_mode })
      .eq("id", id)
      .eq("user_id", auth.user.id)
      .select("id,title,status,teach_mode,created_at,updated_at")
      .single();

    if (error) throw error;
    return NextResponse.json({ session: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent session could not be updated.";
    console.error("[agent-session-update]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

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
      return NextResponse.json({ error: "You can only delete your own agent chats." }, { status: 403 });
    }

    if (session.status === "archived") {
      return NextResponse.json({ ok: true });
    }

    const { error: updateError } = await auth.supabase
      .from("agent_sessions")
      .update({ status: "archived" })
      .eq("id", id)
      .eq("user_id", auth.user.id);

    if (updateError) throw updateError;
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent session could not be deleted.";
    console.error("[agent-session-delete]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
