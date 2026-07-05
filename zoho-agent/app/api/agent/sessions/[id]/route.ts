import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const { data: session, error: sessionError } = await auth.supabase
      .from("agent_sessions")
      .select("id,title,status,created_at,updated_at")
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
    return NextResponse.json({ session, messages: messages ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent session failed to load.";
    console.error("[agent-session-detail]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
