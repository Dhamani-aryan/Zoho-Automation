import { AppShell } from "@/components/app-shell";
import { AgentChat } from "@/components/agent-chat";
import { PageHeader } from "@/components/page-header";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function AgentPage({
  searchParams
}: {
  searchParams: Promise<{ session?: string; draft?: string; prefill?: string }>;
}) {
  const { session: requestedSession, draft, prefill } = await searchParams;
  const supabase = await createServerSupabaseClient();
  let sessions: Array<{
    id: string;
    title: string | null;
    status: string;
    teach_mode: boolean;
    created_at: string;
    updated_at: string;
  }> = [];
  let messages: Array<{
    id: string;
    role: "user" | "assistant" | "tool";
    content: string | null;
    tool_name: string | null;
    tool_args: unknown;
    tool_result: unknown;
    tool_tier: number | null;
    created_at: string;
  }> = [];
  let activeSessionId: string | undefined;

  if (supabase) {
    const {
      data: { user }
    } = await supabase.auth.getUser();

    if (user) {
      const { data } = await supabase
        .from("agent_sessions")
        .select("id,title,status,teach_mode,created_at,updated_at")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(30);
      sessions = data ?? [];

      // Preselect the chat from ?session= when it belongs to this user; else the
      // most recent one.
      const active = sessions.find((session) => session.id === requestedSession) ?? sessions[0];
      activeSessionId = active?.id;

      if (active) {
        const { data: initialMessages } = await supabase
          .from("agent_messages")
          .select("id,role,content,tool_name,tool_args,tool_result,tool_tier,created_at")
          .eq("session_id", active.id)
          .order("created_at", { ascending: true });
        messages = (initialMessages ?? []) as typeof messages;
      }
    }
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="Agent"
        title="Tool-calling agent"
        description="Ask questions against the local Zoho mirror and watch the tool trace as it works."
      />
      <AgentChat
        initialSessions={sessions}
        initialMessages={messages}
        initialActiveSessionId={activeSessionId}
        initialDraft={prefill ?? draft ?? ""}
      />
    </AppShell>
  );
}

