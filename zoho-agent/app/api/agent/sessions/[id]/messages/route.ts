import { requireApiRole } from "@/lib/auth/guards";
import { runAgentTurn, type AgentStreamEvent } from "@/lib/agent/loop";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { agentTurnLockTimeoutMs } from "@/lib/agent/runtime-config";
import { turnClaimDecision } from "@/lib/agent/turn-lock";

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
    .select("id,user_id,status,turn_active_until")
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

  const service = createServiceSupabaseClient();
  if (!service) {
    return Response.json({ error: "Supabase service role is not configured." }, { status: 500 });
  }

  const nowMs = Date.now();
  const decision = turnClaimDecision({
    currentActiveUntil: (session as { turn_active_until?: string | null }).turn_active_until,
    nowMs,
    turnTimeoutMs: agentTurnLockTimeoutMs()
  });
  if (!decision.claimable) {
    return Response.json(
      {
        error:
          "This chat already has an agent turn running. Wait for it to finish, or start a new chat for a separate request.",
        active_until: decision.activeUntilIso
      },
      { status: 409 }
    );
  }

  const nowIso = new Date(nowMs).toISOString();
  const { data: claimedTurn, error: claimError } = await service
    .from("agent_sessions")
    .update({ turn_active_until: decision.activeUntilIso })
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .eq("status", "active")
    .or(`turn_active_until.is.null,turn_active_until.lte.${nowIso}`)
    .select("id")
    .maybeSingle();

  if (claimError) {
    return Response.json({ error: claimError.message }, { status: 500 });
  }
  if (!claimedTurn) {
    return Response.json(
      {
        error:
          "This chat already has an agent turn running. Wait for it to finish, or start a new chat for a separate request.",
        active_until: decision.activeUntilIso
      },
      { status: 409 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          // The browser may stop watching the stream, but the server turn still
          // finishes and clears the lock in finally.
        }
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
        await service
          .from("agent_sessions")
          .update({ turn_active_until: null })
          .eq("id", id)
          .eq("user_id", auth.user.id);
        try {
          controller.close();
        } catch {
          // Stream already closed by the client.
        }
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
