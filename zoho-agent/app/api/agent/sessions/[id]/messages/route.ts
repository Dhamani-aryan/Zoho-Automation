import { requireApiRole } from "@/lib/auth/guards";
import { runAgentTurn, type AgentStreamEvent } from "@/lib/agent/loop";

function encodeEvent(event: AgentStreamEvent) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) {
    return Response.json({ error: "Message content is required." }, { status: 400 });
  }

  const { data: session, error: sessionError } = await auth.supabase
    .from("agent_sessions")
    .select("id,user_id,status")
    .eq("id", id)
    .single();

  if (sessionError || !session) {
    return Response.json({ error: sessionError?.message ?? "Agent session not found." }, { status: 404 });
  }
  // RLS lets admins READ any session, but turns must run only in the owner's
  // session (message inserts would fail RLS mid-turn otherwise).
  if (session.user_id !== auth.user.id) {
    return Response.json({ error: "You can only send messages in your own agent sessions." }, { status: 403 });
  }
  if (session.status !== "active") {
    return Response.json({ error: "This agent session is archived." }, { status: 409 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentStreamEvent) => {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      };

      try {
        await runAgentTurn({
          supabase: auth.supabase,
          user: auth.user,
          sessionId: id,
          content,
          emit
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent turn failed unexpectedly.";
        console.error("[agent-message]", message, error);
        emit({ type: "error", error: message });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
