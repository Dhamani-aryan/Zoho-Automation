import type { SupabaseClient } from "@supabase/supabase-js";
import { ZodError } from "zod";
import {
  isTier0Tool,
  runTier0Tool,
  TIER0_TOOL_DEFINITIONS
} from "@/lib/agent/tier0-tools";
import {
  isInProcessTier1Tool,
  isTier1Tool,
  runInProcessTier1Tool,
  TIER1_TOOL_DEFINITIONS,
  validateTier1ToolCall
} from "@/lib/agent/tier1-tools";
import { runBridgedTool } from "@/lib/agent/bridge";
import {
  isTier2Tool,
  TIER2_TOOL_DEFINITIONS,
  validateTier2Call,
  type Tier2Module
} from "@/lib/agent/tier2-tools";
import {
  buildApprovalRequest,
  createPendingApproval,
  resolvedFromLiveRecord,
  waitForApprovalJob,
  waitForApprovalOutcome,
  type LiveRecordFetch
} from "@/lib/agent/tier2";
import { getLLMProviderForUser } from "@/lib/llm";
import type { AgentPromptMessage, AgentToolCall } from "@/lib/llm/provider";
import type { AuthorizedUser } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { agentMaxToolCalls, agentTurnTimeoutMs } from "@/lib/agent/runtime-config";

const TOOL_RESULT_CHAR_LIMIT = 8000;

export type AgentStreamEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; call: AgentToolCall; tier: 0 | 1 | 2 }
  | { type: "tool_status"; call_id: string; tool_name: string; status: "queued" | "running" }
  | {
      type: "approval_required";
      call_id: string;
      approval_id: string;
      tool_name: string;
      summary: unknown;
    }
  | { type: "tool_result"; call_id: string; tool_name: string; result: unknown; ok: boolean }
  | { type: "done" }
  | { type: "error"; error: string };

type Emit = (event: AgentStreamEvent) => void | Promise<void>;

type AgentMessageRow = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  tool_result: unknown;
};

const AGENT_INSTRUCTIONS = `You are the Zoho Automation tool agent.

Use tools when you need facts. Local DB tools read the Supabase mirror; Zoho tools read live data through the user's Chrome extension.
Never claim a local mirror answer is live Zoho data. Say "as of last sync" for DB-sourced answers.
For a specific record question, search the mirror first to resolve likely records, then use live Zoho reads when the user needs current field values.
Always label live Zoho answers as live from Zoho. If the extension is offline, say that clearly and offer the mirror answer instead.
For tag-driven pull/sync requests, use zoho_search with the tag, paginate until Zoho says there are no more records, then call db_sync_records with only the records the user asked to sync. Report inserted, updated, unchanged, and warnings.
Treat the user's wording as intent, not exact values - users will be approximate and should not have to phrase things precisely. A phrase like "the deal with the tag test search" may mean the tag is "test", or that the deal name or a field contains those words; infer the most likely meaning and try it.
When a search returns no results, do NOT stop after one attempt and report "not found". Work the request: (1) retry with a broader or alternative term - try each significant word on its own, or switch approach (tag vs name vs criteria); (2) discover what actually exists - use db_list_tags to see real tag names and pick the closest, or db_list_by_tag / db_search_records to find records whose name or fields contain the words; (3) only if there is still no confident match, briefly say what you tried and either offer the closest candidates or ask one short clarifying question. Prefer resolving it yourself over making the user restate it. Stay within the tool-call budget.
If a user asks for an unsupported capability, call request_new_tool with a concise name, purpose, and example_call.
You CAN give direct Zoho record links; never say you lack a tool for them. Mirror rows from db_get_record / db_search_records include zoho_url - prefer it. Otherwise compose the canonical URL from the record's Zoho id: https://crm.zoho.com/crm/org890324941/tab/{Potentials|Contacts|Accounts}/{zoho_id} - note Deals use "Potentials" in URLs even though the API module is Deals.
CRM writes are available through approval-gated tools: zoho_update_fields, zoho_change_owner, zoho_add_tags, zoho_remove_tags. Every such call pauses for the user to approve a before/after card in chat before anything is written; nothing is written until they approve. Only propose a write the user actually asked for, resolve the exact record(s) first (search the mirror or read live Zoho), and put the smallest correct change in the tool call. If the user rejects the card, acknowledge it and do not retry the same write unless they ask. Stage edits are admin-only and Deal_Name cannot be changed. Never claim a write succeeded until the tool result confirms it (verified read-back). Deletes, record creation, and UI actions remain unavailable.
When you have enough information, answer in natural, conversational language. For a simple lookup, prefer one or two short sentences, like "Duraco's live Next Step is Call, and the deal is currently in Follow-Up." Do not default to rigid report headings or bullet lists unless there are multiple records, several values to compare, or the user asks for a list.
Keep source clarity in the sentence: say "live in Zoho" for live reads, and "as of last sync" for mirror-only answers.`;

const AGENT_TOOL_DEFINITIONS = [...TIER0_TOOL_DEFINITIONS, ...TIER1_TOOL_DEFINITIONS, ...TIER2_TOOL_DEFINITIONS];

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

function callIdFromArgs(args: Record<string, unknown> | null) {
  return typeof args?._call_id === "string" ? args._call_id : undefined;
}

function messageRowsToPrompt(rows: AgentMessageRow[]): AgentPromptMessage[] {
  const prompt: AgentPromptMessage[] = [];
  for (const row of rows) {
    const callId = callIdFromArgs(row.tool_args);
    if (row.role === "tool") {
      prompt.push({
        role: "tool",
        toolName: row.tool_name ?? undefined,
        content: row.tool_result == null ? row.content ?? "" : stringifyForModel(row.tool_result),
        callId
      });
      continue;
    }
    // Skip assistant tool-call marker rows (tool_name set, no content) — they
    // exist for the UI trace/audit, but replaying them as empty assistant
    // messages just pollutes the prompt.
    if (row.role === "assistant" && !row.content?.trim()) {
      if (row.tool_name && callId) {
        prompt.push({
          role: "tool_call",
          content: "",
          toolName: row.tool_name,
          callId,
          args: row.tool_args ?? {}
        });
      }
      continue;
    }
    prompt.push({ role: row.role, content: row.content ?? "" });
  }
  return prompt;
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

function normalizeModule(value: unknown): Tier2Module | "" {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "accounts") return "Accounts";
  if (raw === "contacts") return "Contacts";
  if (raw === "deals") return "Deals";
  return "";
}

function liveNameField(module: Tier2Module): string {
  if (module === "Accounts") return "Account_Name";
  if (module === "Contacts") return "Full_Name";
  return "Deal_Name";
}

// Live-fetch fallback for the approval summary, backed by the Phase B read
// bridge. Best-effort: if the extension is offline the bridge throws and the
// summary shows "unknown - verify in card".
function makeLiveFetch(service: SupabaseClient, user: AuthorizedUser, sessionId: string): LiveRecordFetch {
  return async ({ module, zohoIds, fields }) => {
    const out = new Map<string, ReturnType<typeof resolvedFromLiveRecord>>();
    const requested = [...new Set([...fields, liveNameField(module)])];
    for (const zohoId of zohoIds) {
      try {
        const body = (await runBridgedTool({
          service,
          user,
          sessionId,
          call: { id: `approval-summary-${zohoId}`, name: "zoho_get_record", args: { module, zoho_id: zohoId, fields: requested } }
        })) as { data?: Array<Record<string, unknown>> } | null;
        const record = Array.isArray(body?.data) ? body?.data[0] : undefined;
        if (record) out.set(zohoId, resolvedFromLiveRecord(module, record));
      } catch {
        // Skip this record; the summary will mark it unknown.
      }
    }
    return out;
  };
}

// Runs the full approval gate for one validated Tier-2 call and returns the
// observation to feed back to the model. Validation errors throw (never reach a
// card); reject/expire are normal observations, not exceptions.
async function handleTier2Call({
  supabase,
  service,
  user,
  sessionId,
  call,
  emit
}: {
  supabase: SupabaseClient;
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const moduleGuess = normalizeModule((call.args as { module?: unknown })?.module);
  const { data: metaRows } = moduleGuess
    ? await service
        .from("zoho_field_meta")
        .select("module,api_name,data_type,picklist_values")
        .eq("module", moduleGuess)
    : { data: [] as Array<{ module: string; api_name: string; data_type: string | null; picklist_values: unknown }> };

  // Throws on invalid args/rules -> caught by the caller as an error observation.
  const prepared = validateTier2Call(call, { fieldMeta: metaRows ?? [], role: user.role });

  const liveFetch = makeLiveFetch(service, user, sessionId);
  const { summary, snapshot } = await buildApprovalRequest({ supabase, prepared, liveFetch });
  const approvalId = await createPendingApproval({
    service,
    sessionId,
    userId: user.id,
    snapshot,
    summary
  });

  await emit({
    type: "approval_required",
    call_id: call.id,
    approval_id: approvalId,
    tool_name: call.name,
    summary
  });

  const decision = await waitForApprovalOutcome({ service, approvalId, userId: user.id });
  if (decision.outcome === "rejected") {
    return {
      ok: false,
      result: { approval_id: approvalId, status: "rejected", error: "The user rejected this action." },
      pausedMs: decision.waitedMs
    };
  }
  if (decision.outcome === "expired") {
    return {
      ok: false,
      result: { approval_id: approvalId, status: "expired", error: "The approval expired before the user decided." },
      pausedMs: decision.waitedMs
    };
  }

  const job = await waitForApprovalJob({ service, approvalId, userId: user.id });
  const pausedMs = decision.waitedMs + job.waitedMs;
  const jobResult = job.result as Record<string, unknown> | null;
  return {
    ok: job.ok,
    result: {
      approval_id: approvalId,
      status: job.ok ? "executed" : "failed",
      ...(jobResult && typeof jobResult === "object" ? jobResult : { result: jobResult })
    },
    pausedMs
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
  const service = createServiceSupabaseClient();

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
    .select("role,content,tool_name,tool_args,tool_result")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(80);
  if (loadError) throw loadError;

  const transcript = messageRowsToPrompt((rows ?? []) as AgentMessageRow[]);
  let toolCallCount = 0;
  // Time spent blocked on a Tier-2 approval card does NOT count against the
  // turn budget (a human may take minutes to decide). We subtract it.
  let pausedMs = 0;
  const turnTimeoutMs = agentTurnTimeoutMs();
  const maxToolCalls = agentMaxToolCalls();

  while (Date.now() - started - pausedMs < turnTimeoutMs) {
    const model = await provider.runTools({
      instructions: AGENT_INSTRUCTIONS,
      messages: transcript,
      tools: AGENT_TOOL_DEFINITIONS
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
      if (toolCallCount >= maxToolCalls) {
        const message = `Stopped after reaching the ${maxToolCalls} tool-call budget.`;
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
      const tier = AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === call.name)?.tier ?? 0;
      await emit({ type: "tool_call", call, tier });
      await supabase.from("agent_messages").insert({
        session_id: sessionId,
        role: "assistant",
        tool_name: call.name,
        tool_args: { ...call.args, _call_id: call.id },
        tool_tier: tier
      });
      transcript.push({
        role: "tool_call",
        content: "",
        toolName: call.name,
        callId: call.id,
        args: call.args
      });

      let ok = true;
      let result: unknown;
      try {
        if (isTier0Tool(call.name)) {
          result = await runTier0Tool({ call, supabase, userId: user.id });
        } else if (isTier1Tool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for extension jobs.");
          const validatedCall = await validateTier1ToolCall(call, service);
          if (isInProcessTier1Tool(validatedCall.name)) {
            result = await runInProcessTier1Tool({ call: validatedCall, service, userId: user.id });
          } else {
            result = await runBridgedTool({
              service,
              user,
              sessionId,
              call: validatedCall,
              onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
            });
          }
        } else if (isTier2Tool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for approvals.");
          const gated = await handleTier2Call({ supabase, service, user, sessionId, call, emit });
          ok = gated.ok;
          result = gated.result;
          pausedMs += gated.pausedMs;
        } else {
          throw new Error(`Unknown or unavailable tool "${call.name}".`);
        }
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
        tool_args: { ...call.args, _call_id: call.id },
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
        content: stringifyForModel(truncated),
        callId: call.id
      });
      await emit({ type: "tool_result", call_id: call.id, tool_name: call.name, result: truncated, ok });
    }
  }

  const message = `Stopped after reaching the ${Math.round(turnTimeoutMs / 1000)} second turn budget.`;
  await supabase.from("agent_messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: message
  });
  await emit({ type: "assistant_delta", text: message });
  await emit({ type: "done" });
}
