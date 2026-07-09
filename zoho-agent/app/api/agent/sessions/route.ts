import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";

export async function GET() {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  try {
    const { data, error } = await auth.supabase
      .from("agent_sessions")
      .select("id,title,status,teach_mode,created_at,updated_at")
      .eq("user_id", auth.user.id)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(30);

    if (error) throw error;
    return NextResponse.json({ sessions: data ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent sessions failed to load.";
    console.error("[agent-sessions-list]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  try {
    const body = (await request.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
    const { data, error } = await auth.supabase
      .from("agent_sessions")
      .insert({
        user_id: auth.user.id,
        title
      })
      .select("id,title,status,teach_mode,created_at,updated_at")
      .single();

    if (error) throw error;
    return NextResponse.json({ session: data }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent session could not be created.";
    console.error("[agent-sessions-create]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
