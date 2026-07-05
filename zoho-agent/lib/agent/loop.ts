import type { SupabaseClient } from "@supabase/supabase-js";
import { ZodError } from "zod";
import {
  isTier0Tool,
  runTier0Tool,
  TIER0_TOOL_DEFINITIONS
} from "@/lib/agent/tier0-tools";
import { getLLMProviderForUser } from "@/lib/llm";
import type { AgentPromptMessage, AgentToolCall } from "@/lib/llm/provider";
import type { AuthorizedUser } from "@/lib/auth/guards";

const MAX_TOOL_CALLS = 15;
const TURN_TIMEOUT_MS = 3 * 60 * 1000;
const TOOL_RESULT_CHAR_LIMIT = 8000;

export type AgentStreamEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; call: AgentToolCall; tier: 0 | 1 | 2 }
  | { type: "tool_result"; call_id: string; tool_name: string; result: unknown; ok: boolean }
  | { type: "done" }
  | { type: "error"; error: string };

type Emit = (event: AgentStreamEvent) => void | Promise<void>;

type AgentMessageRow = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_name: string | null;
  tool_result: unknown;
};

const AGENT_INSTRUCTIONS = `You are the Zoho Automation tool agent.

Use tools when you need facts. Phase A tools only read the local Supabase mirror or file a missing-tool request.
Never claim a local mirror answer is live Zoho data. Say "as of last sync" for DB-sourced answers.
For a specific record question, search first, then fetch the record if needed.
If a user asks for an unsupported capability, call request_new_tool with a concise name, purpose, and example_call.
Do not invent Zoho writes, deletes, record creation, or UI actions. CRM writes require later approval-gated tools and are unavailable in Phase A.
When you have enough information, answer briefly with the relevant record names and values.`;

function titleFromMessage(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 80) || "Agent chat";
}

function stringifyForModel(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function truncateToolResult(value: unknown) {
  const text = stringifyForModel(value);
  if (text.length <= TOOL_RESULT_CHAR_LIMIT) return value;
  return {
    truncated: true,
    original_char_count: text.length,
    preview: text.slice(0, TOOL_RESULT_CHAR_LIMIT)
  };
}

function messageRowsToPrompt(rows: AgentMessageRow[]): AgentPromptMessage[] {
  return rows.map((row) => {
    if (row.role === "tool") {
      return {
        role: "tool",
        toolName: row.tool_name ?? undefined,
        content: row.tool_result == null ? row.content ?? "" : stringifyForModel(row.tool_result)
      };
    }
    return {
      role: row.role,
      content: row.content ?? ""
    };
  });
}

function toolError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      error: "Tool arguments failed validation.",
      issues: error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  }
  return {
    error: error instanceof Error ? error.message : "Tool failed unexpectedly."
  };
}

export async function runAgentTurn({
  supabase,
  user,
  sessionId,
  content,
  emit
}: {
  supabase: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  content: string;
  emit: Emit;
}) {
  const started = Date.now();
  const provider = await getLLMProviderForUser(user.id);

  const { error: userMessageError } = await supabase.from("agent_messages").insert({
    session_id: sessionId,
    role: "user",
    content
  });
  if (userMessageError) throw userMessageError;

  await supabase
    .from("agent_sessions")
    .update({ title: titleFromMessage(content) })
    .eq("id", sessionId)
    .is("title", null);

  const { data: rows, error: loadError } = await supabase
    .from("agent_messages")
    .select("role,content,tool_name,tool_result")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(80);
  if (loadError) throw loadError;

  const transcript = messageRowsToPrompt((rows ?? []) as AgentMessageRow[]);
  let toolCallCount = 0;

  while (Date.now() - started < TURN_TIMEOUT_MS) {
    const model = await provider.runTools({
      instructions: AGENT_INSTRUCTIONS,
      messages: transcript,
      tools: TIER0_TOOL_DEFINITIONS
    });

    if (model.text.trim()) {
      await supabase.from("agent_messages").insert({
        session_id: sessionId,
        role: "assistant",
        content: model.text
      });
      transcript.push({ role: "assistant", content: model.text });
      await emit({ type: "assistant_delta", text: model.text });
    }

    if (model.toolCalls.length === 0) {
      await supabase.from("audit_events").insert({
        user_id: user.id,
        event_type: "agent_turn",
        message: `Agent turn completed with ${toolCallCount} tool call(s).`,
        metadata: { session_id: sessionId, provider: provider.name, latency_ms: Date.now() - started }
      });
      await emit({ type: "done" });
      return;
    }

    for (const call of model.toolCalls) {
      if (toolCallCount >= MAX_TOOL_CALLS) {
        const message = `Stopped after reaching the ${MAX_TOOL_CALLS} tool-call budget.`;
        await supabase.from("agent_messages").insert({
          session_id: sessionId,
          role: "assistant",
          content: message
        });
        await emit({ type: "assistant_delta", text: message });
        await emit({ type: "done" });
        return;
      }

      toolCallCount += 1;
      const tier = TIER0_TOOL_DEFINITIONS.find((tool) => tool.name === call.name)?.tier ?? 0;
      await emit({ type: "tool_call", call, tier });
      await supabase.from("agent_messages").insert({
        session_id: sessionId,
        role: "assistant",
        tool_name: call.name,
        tool_args: call.args,
        tool_tier: tier
      });

      let ok = true;
      let result: unknown;
      try {
        if (!isTier0Tool(call.name)) {
          throw new Error(`Unknown or unavailable tool "${call.name}" in Phase A.`);
        }
        result = await runTier0Tool({ call, supabase, userId: user.id });
      } catch (error) {
        ok = false;
        result = toolError(error);
      }

      const truncated = truncateToolResult(result);
      await supabase.from("agent_messages").insert({
        session_id: sessionId,
        role: "tool",
        content: ok ? null : (truncated as { error?: string }).error ?? "Tool failed.",
        tool_name: call.name,
        tool_args: call.args,
        tool_result: truncated,
        tool_tier: tier
      });
      await supabase.from("audit_events").insert({
        user_id: user.id,
        event_type: "tool_call",
        message: `${ok ? "Ran" : "Failed"} agent tool ${call.name}.`,
        metadata: { session_id: sessionId, call_id: call.id, tool_name: call.name, ok }
      });
      transcript.push({
        role: "tool",
        toolName: call.name,
        content: stringifyForModel(truncated)
      });
      await emit({ type: "tool_result", call_id: call.id, tool_name: call.name, result: truncated, ok });
    }
  }

  const message = "Stopped after reaching the 3 minute turn budget.";
  await supabase.from("agent_messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: message
  });
  await emit({ type: "assistant_delta", text: message });
  await emit({ type: "done" });
}
