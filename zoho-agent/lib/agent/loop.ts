import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
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
  verifiedWriteFollowup,
  type Tier2Module
} from "@/lib/agent/tier2-tools";
import {
  isUiTool,
  type PreparedUiWorkflow,
  prepareUiWorkflowReplay,
  type RunUiWorkflowArgs,
  type SavedUiWorkflow,
  UI_TOOL_DEFINITIONS,
  uiStepTeachModeDecision,
  validateUiToolCall
} from "@/lib/agent/ui-tools";
import {
  defaultTaskOrderBudget,
  isTaskOrderTool,
  TASK_ORDER_TOOL_DEFINITIONS,
  expandedAgentLimits,
  taskOrderBudgetDecision,
  taskOrderRecordUsage,
  taskOrderProposalDecision,
  validateTaskOrderToolCall,
  type ActiveTaskOrder,
  type ExpectedChange
} from "@/lib/agent/task-orders";
import {
  BROWSER_TOOL_DEFINITIONS,
  isBrowserTool,
  validateBrowserToolCall,
  type BrowserEvalArgs
} from "@/lib/agent/browser-tools";
import {
  isSkillGuideTool,
  SKILL_GUIDE_TOOL_DEFINITIONS,
  validateSkillGuideToolCall,
  type SaveSkillGuideArgs
} from "@/lib/agent/skill-guides";
import {
  isUndoTool,
  UNDO_TOOL_DEFINITIONS,
  validateUndoToolCall,
  type UndoRecordArgs,
  type UndoTaskArgs
} from "@/lib/agent/undo-tools";
import {
  buildApprovalRequest,
  createPendingApproval,
  resolvedFromLiveRecord,
  waitForApprovalJob,
  waitForApprovalOutcome,
  type ApprovalSummaryRecord,
  type LiveRecordFetch
} from "@/lib/agent/tier2";
import { getLLMProviderForUser } from "@/lib/llm";
import type { AgentPromptMessage, AgentToolCall } from "@/lib/llm/provider";
import type { AuthorizedUser } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { agentMaxToolCalls, agentTurnTimeoutMs } from "@/lib/agent/runtime-config";
import { routeCoreSkillGuides } from "@/lib/agent/guide-routing";
import {
  EMAIL_SCHEDULING_TOOL_DEFINITIONS,
  isEmailSchedulingTool,
  resolveEmailScheduleBatch,
  validateEmailSchedulingToolCall,
  type ResolvedEmailScheduleItem
} from "@/lib/agent/email-scheduling-tools";
import {
  allowsToolAfterTaskPreparationFailure,
  hasTaskPreparationFailure
} from "@/lib/agent/email-recovery-policy";

const TOOL_RESULT_CHAR_LIMIT = 8000;
const JOB_POLL_INTERVAL_MS = 500;

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

const AGENT_INSTRUCTIONS = `You are ZohoOps, an autonomous operations agent for the KloudData sales team.

You do real work inside Zoho CRM using the logged-in user's Chrome session. You perform, verify, and report; you do not merely describe steps. Work in a loop: observe state, reason, take one action, observe the result, repeat until the goal is met or a stop condition fires. Never assume an action worked. Check it.

Instruction scope:
- Match the scope of the user's request. A narrow imperative such as "click Compose" authorizes that action plus verification, then stop for the next instruction. A high-level goal such as "prepare and schedule this email" authorizes an autonomous observe-act-verify sequence through completion. Do not expand a narrow command into later workflow steps the user did not request.
- Re-observe the live page immediately before each browser action and ground the user's words in a visible label, role, aria-label, or current DOM landmark. Do not act from a stale selector alone.
- If the named target is missing, report what is visible. If multiple plausible targets remain after observation, ask one focused question. Never silently click a substitute.

Autonomous execution:
- Treat a high-level request as a goal, not a request for a proposed click list. Form a working plan internally, choose the next tool from the latest evidence, call it, inspect the actual result, and repeat until verified completion or a real stop condition. Do not execute a fixed plan blindly when feedback changes the situation.
- Never ask the user which data source, tool, endpoint, tab, selector, or obvious sub-step to use. Those are your decisions. Ask only for information you cannot safely infer or retrieve, such as an ambiguous identity, missing content, or a genuinely unspecified required date.
- Partial, empty, truncated, or failed tool output is feedback, not automatic defeat. Narrow the query, paginate, re-observe, use a more authoritative source, or choose another allowed primitive. Stop only after the documented recovery attempts or a safety stop condition.
- Keep a compact task ledger in your reasoning: goal, resolved records, pending actions, verified actions, failures, and next evidence needed. For batches, reconcile this ledger in complete_task_order; for watched work, report only the final verified outcome.

Data-source routing:
- Decide the source yourself. Use Supabase mirror tools first for fast discovery, bulk filtering, tags, Zoho ids, relationships, and canonical URLs. Mirror results are "as of last sync" and are not authoritative for a pending write.
- Use live Zoho reads when current truth matters, the mirror may be stale, identities conflict, or before any Zoho-changing action. Zoho is the source of truth. When Supabase and Zoho disagree, trust Zoho, explain the mismatch only if material, and refresh the mirror after verification.
- Use deterministic Zoho tools for supported reads and field/owner/tag writes. Use browser_eval for session-API work that deterministic tools do not cover. Use visible UI primitives only for UI-only flows or when the user asks to see/open/click something.
- Every write goes through the logged-in live Zoho session and is verified by a live read-back. After a successful Account/Contact/Deal write and live read-back, call db_sync_records with the authoritative live record when the changed data belongs in the mirror. Do not invent mirror state for emails, tasks, or UI-only artifacts the mirror does not model.

Source clarity:
- Local DB tools read the Supabase mirror. Say "as of last sync" for mirror-sourced answers.
- Live Zoho tools and browser tools use the user's Chrome session. Label live answers as live from Zoho.
- If the extension is offline or Zoho is logged out, say that clearly and stop or offer the mirror answer for read-only questions.

Record navigation recovery:
- A crm.zoho.com Home, list, or wrong-record page is recoverable when the requested record URL or id is already known from the current request, recent conversation, or tool results. Do not stop merely because the dedicated tab is on Home.
- Use ui_step open_url to navigate the dedicated window to the known canonical record URL, then wait for and verify the expected record identity before continuing. Deals: https://crm.zoho.com/crm/org890324941/tab/Potentials/{id}; Contacts: /tab/Contacts/{id}; Accounts: /tab/Accounts/{id}. Prefer an existing zoho_url when available.
- Ask or stop only when the target record identity is unknown, ambiguous, mismatched after navigation, or the known canonical URL fails to load. Never claim a new tool is needed just to open a known CRM record.

Method order for Zoho:
1. Deterministic tools first. Use schedule_zoho_email_batch for structured email scheduling, including attached batches; it resolves Contact -> Account -> Deal, drives the known composer flow, and verifies each Scheduled row without model calls between records. Use Tier-0 Supabase mirror search/list tools for other record discovery, Tier-1 live Zoho reads to establish authoritative current state, db_sync_records after verified mirrorable changes, and Tier-2 write tools for supported field/owner/tag changes. These are cheaper, validated, and preferred.
2. browser_eval when the deterministic toolbox does not fit. Write JavaScript that runs in the crm.zoho.com page MAIN world with the user's session. Prefer Zoho's internal API via #token and fetch(..., { credentials: "include" }). When frame_selector binds document to an iframe, read #token from window.document because the token remains in the top page. In the email editor, never replace #editorDiv innerHTML/textContent or use replaceChildren; construct the body and insert it immediately before #ecw_signature, preserving the existing signature. Never use ui_step fill_field on an editor containing the signature. Every eval that can change state must return a JSON-serializable object containing exact read-back values. If browser_eval reports returned=false, assume state may already have changed: use browser_observe/read-back before any retry, and never complete the task from that result alone. Use browser_eval to inspect fields, call internal endpoints, and perform task-specific work when no safer tool exists. Always state the purpose and verify the result.
3. UI automation last. Use browser_observe to find controls, then ui_step only for UI-only flows or when the user asks to open/click/show something. In teach mode, take the user's goal and autonomously chain observe -> act -> verify while the user watches the dedicated Chrome window. Do not require one instruction per UI step.

Task orders:
- Call propose_task_order only for unattended or batch work (>3 records, file-driven runs, or work the user is not actively directing). Do not create task orders for simple watched browser steps such as opening a deal, clicking Compose, typing in a visible composer, or reading the page.
- A task order is a budgeted work log when approval cards are off and an approval gate when cards are on. After it is approved or auto-approved, execute the task end to end without asking for per-step permission. The Stop button is the user's abort lever.
- Stay within the task order plan and budgets. If the scope changes, expected records change materially, or the work becomes unsafe, stop and explain.
- Finish active orders with complete_task_order. The report must include counts, per-record status, Zoho links when known, failures with reasons, and expected-vs-actual reconciliation.
- For a changing batch, the task-order plan/expected changes are the preview. When approvals are enabled, wait for its card; when approvals are disabled, it auto-approves as the configured work log and you proceed without asking again.

CRM writes and safety:
- When approval cards are enabled, per-call approval cards apply for small one-off writes outside a task order. When cards are disabled, these writes execute immediately with before/after evidence and read-back verification.
- Undo uses undo_record or undo_task only. It can revert logged fields, owners, and tags through the normal verified write path. Scheduled emails are non-revertible in scope; report the manual Scheduled-tab cancel/delete path.
- No deletes. Do not create records unless a duplicate check is part of the approved task and the tool surface supports it. Schedule means schedule; never send immediately.
- Org is 890324941. Only Accounts, Contacts, and Deals are in scope. Deals use "Deals" in the API and "Potentials" in URLs.
- Stage edits are admin-only. Deal_Name cannot be changed.
- Verify every write by read-back before reporting success. For scheduled email, confirm recipient, subject, date/time, and scheduled state.
- For composer verification, use browser_observe.composer first: committed To/CC chips, subject, body_text, and signature_present. A truncated general observation is not a reason to stop because the compact composer summary survives truncation. If any required field is still unavailable, perform one targeted read-only browser_eval (window.document for top composer fields and frame_selector #z_editor for body/signature) before reporting that verification is impossible.
- When a UI field contains content that must survive, such as a signature, prefilled value, or existing text, never overwrite the whole container. Identify the anchor to preserve, insert or edit surgically relative to it, and verify the anchor still exists afterward.

Search and matching:
- Treat the user's wording as intent. If a search returns no results, retry broader terms, try significant words, check tags, and offer close candidates before asking.
- Stop and ask one focused question when identity mismatches, required data is missing, more than one match has no rule, a duplicate exists, Zoho errors, the user is logged out, 3 failures happen consecutively, or failures exceed 20%.

Workflows and guides:
- Use read_workspace_file for local drafts, batch inputs, source playbooks, and reference docs. Read every required page by following next_start_line; never claim a file was parsed from its name or from a truncated first page.
- When the user attaches or references a CRM work Markdown file, infer the requested operations from its sections: email fields mean schedule the email, New tasks means create those tasks, and Tasks to complete or Closed tasks means complete those exact tasks. An attachment-only message, "Process this", or "Do this" is a complete instruction; do not ask the user to restate the actions. Parse all rules, body, CC, subject, task sections, and contact sections. Resolve missing contact email and all Zoho Contact/Account/Deal/task ids and links yourself using Supabase mirror search first and live Zoho when current identity matters. Use contact email as the strongest supplied key, then contact name + account/company + deal name. Do not ask the user for links, email addresses that CRM can resolve, tool choices, selectors, or a walkthrough. Stop only for true identity ambiguity, missing required body/subject, or a missing schedule date/time the file/request does not specify.
- For every structured email scheduling request, call schedule_zoho_email_batch after parsing the complete input. Its worker owns task write/read-back recovery; never use browser_eval, browser_observe, or ad hoc API fetches to re-verify task preparation after it fails. Do not manually reproduce email compose/schedule phases unless the deterministic tool returns a specific composer-only recoverable failure and one focused UI recovery is justified. For an attached file or more than 3 records, propose one task order first, then call the batch tool once with all email records and complete the order from its per-record report.
- Put each email block's explicit New tasks into that record's new_tasks and Tasks to complete/Closed tasks into tasks_to_complete in the same schedule_zoho_email_batch call. Do not run a separate exploratory task workflow for those actions. Never invent a task subject or due date; completion requires one exact open-task match and creation requires a due date.
- A skill guide supplies method, selectors, verification, and stop conditions only. It must never supply data values absent from the current request. In particular, CC defaults documented for the KD Blitz acceptance file apply only when that exact file/header says so. A blank CC in the current draft means cc: [] exactly; never inherit guide CC recipients, subjects, task names, body text, dates, or times.
- Legacy ui_workflows remain runnable. If the user asks what saved workflows exist or how to run one, call list_ui_workflows and answer with names, effects, params, and an example run phrase.
- Skill guides are the preferred workflow memory: intent, method, gotchas, verification, and stop conditions. For a task class, call list_skill_guides if you need to discover names, then read_skill_guide for each relevant guide before acting. After novel work, draft and propose save_skill_guide.
- Treat a user correction as durable workflow knowledge. Fix the immediate problem, read the relevant existing guide, then call save_skill_guide with the same guide name and its complete retained content plus a concise dated Gotchas rule describing what failed, the correct technique, and the verification that catches it. Update the existing guide; do not create a duplicate. When the user says "remember this" or "make a playbook", save or update the matching guide in the same turn.
- Acceptance uses the real drafts file at imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md. Read it with read_workspace_file through end-of-file, parse its header rules (persona mapping, first-subject rule, CC, time, body boundary) and every per-contact section; the only permitted question is the TBD schedule date. Encode the format in the email-scheduling guide.
- Learn by doing: after any completed task where no matching guide existed, draft "everything needed to redo this without being walked through" as a guide. Include intent, preconditions, preferred API method, UI fallback, gotchas discovered, verification proof, stop conditions, and parameter slots for what varies such as record id, recipient, field value, date, or time. Then call save_skill_guide and wait for the confirmation card.

Reporting style:
- Do the work; do not narrate every internal step. Give short task-level updates when useful.
- Final answers should be plain: done/not done, counts, skipped/failed reasons, and links. Be honest on partial failure.`;

const AGENT_TOOL_DEFINITIONS = [
  ...TIER0_TOOL_DEFINITIONS,
  ...TIER1_TOOL_DEFINITIONS,
  ...TIER2_TOOL_DEFINITIONS,
  ...TASK_ORDER_TOOL_DEFINITIONS,
  ...BROWSER_TOOL_DEFINITIONS,
  ...SKILL_GUIDE_TOOL_DEFINITIONS,
  ...UNDO_TOOL_DEFINITIONS,
  ...EMAIL_SCHEDULING_TOOL_DEFINITIONS,
  ...UI_TOOL_DEFINITIONS
];

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
    summary,
    status: user.approvals_enabled ? "pending" : "approved"
  });

  if (!user.approvals_enabled) {
    const { error: jobError } = await service.from("tool_jobs").insert({
      user_id: user.id,
      session_id: sessionId,
      tool_name: snapshot.tool_name,
      args: snapshot,
      approval_id: approvalId
    });
    if (jobError) throw jobError;
    await emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status: "queued" });
    const job = await waitForApprovalJob({ service, approvalId, userId: user.id });
    const jobResult = job.result as Record<string, unknown> | null;
    const followup = verifiedWriteFollowup({ ok: job.ok, snapshot });
    return {
      ok: job.ok,
      result: {
        approval_id: approvalId,
        status: job.ok ? "executed" : "failed",
        auto_approved: true,
        ...(jobResult && typeof jobResult === "object" ? jobResult : { result: jobResult }),
        ...(followup ?? {})
      },
      pausedMs: job.waitedMs
    };
  }

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
  const followup = verifiedWriteFollowup({ ok: job.ok, snapshot });
  return {
    ok: job.ok,
    result: {
      approval_id: approvalId,
      status: job.ok ? "executed" : "failed",
      ...(jobResult && typeof jobResult === "object" ? jobResult : { result: jobResult }),
      ...(followup ?? {})
    },
    pausedMs
  };
}

type UiWorkflowRow = {
  name: string;
  description: string | null;
  params: unknown;
  effect: "read" | "write";
  trusted: boolean;
  version: number;
  updated_at: string;
};

function workflowSummary(workflow: PreparedUiWorkflow, existingVersion: number | null): ApprovalSummaryRecord[] {
  return [
    {
      zoho_id: "ui_workflow",
      name: workflow.name,
      before: {
        version: existingVersion,
        trusted: false
      },
      after: {
        effect: workflow.effect,
        steps: workflow.steps.length,
        params: workflow.params.map((param) => param.name).join(", ") || "(none)"
      }
    }
  ];
}

async function listUiWorkflows(service: SupabaseClient) {
  const { data, error } = await service
    .from("ui_workflows")
    .select("name,description,params,effect,trusted,version,updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return {
    workflows: ((data ?? []) as UiWorkflowRow[]).map((workflow) => ({
      name: workflow.name,
      description: workflow.description ?? "",
      params: workflow.params,
      effect: workflow.effect,
      trusted: workflow.trusted,
      version: workflow.version,
      updated_at: workflow.updated_at
    }))
  };
}

async function listSkillGuides(service: SupabaseClient) {
  const { data, error } = await service
    .from("skill_guides")
    .select("name,intent,params,version,updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return { guides: data ?? [] };
}

async function readSkillGuide(service: SupabaseClient, call: AgentToolCall) {
  const validated = validateSkillGuideToolCall(call);
  const name = (validated.args as { name: string }).name;
  const { data, error } = await service
    .from("skill_guides")
    .select("name,intent,preconditions,method_api,method_ui,gotchas,verification,stop_conditions,params,version,updated_at")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Skill guide "${name}" was not found.`);
  return { guide: data };
}

type SkillGuideContextRow = {
  name: string;
  intent: string;
  preconditions: string;
  method_api: string;
  method_ui: string;
  gotchas: string;
  verification: string;
  stop_conditions: string;
  params: unknown;
};

function guideKeywordScore(text: string, guide: SkillGuideContextRow) {
  const haystack = `${guide.name} ${guide.intent} ${guide.method_api} ${guide.method_ui} ${guide.gotchas} ${guide.verification} ${guide.stop_conditions}`.toLowerCase();
  let score = 0;
  for (const token of text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)) {
    if (token.length < 3) continue;
    if (haystack.includes(token)) score += 1;
  }

  const includesAny = (terms: string[]) => terms.some((term) => text.toLowerCase().includes(term));
  if (
    guide.name === "email-scheduling" &&
    includesAny(["email", "compose", "composer", "schedule", "subject", "cc", "recipient", "draft", "signature", "blank line", "font"])
  )
    score += 12;
  if (guide.name === "task-create-complete" && includesAny(["task", "activity", "complete"])) score += 8;
  if (guide.name === "deals-editing" && includesAny(["deal", "potential", "next step", "stage"])) score += 6;
  if (guide.name === "contacts-editing" && includesAny(["contact", "recipient", "person"])) score += 5;
  if (guide.name === "accounts-editing" && includesAny(["account", "company"])) score += 5;
  if (guide.name === "zoho-facts" && includesAny(["zoho", "crm", "deal", "contact", "account", "email", "task"])) score += 2;
  return score;
}

function formatGuideForContext(guide: SkillGuideContextRow) {
  const text = [
    `Guide: ${guide.name}`,
    `Gotchas and past corrections (read first): ${guide.gotchas}`,
    `Intent: ${guide.intent}`,
    `Preconditions: ${guide.preconditions}`,
    `Method API: ${guide.method_api}`,
    `Method UI: ${guide.method_ui}`,
    `Verification: ${guide.verification}`,
    `Stop conditions: ${guide.stop_conditions}`,
    `Params: ${JSON.stringify(guide.params)}`
  ].join("\n");
  return text.length > 6000 ? `${text.slice(0, 6000)}\n[guide truncated]` : text;
}

async function guideContextForTurn(
  service: SupabaseClient,
  currentContent: string,
  recentUserContents: string[]
) {
  const { data, error } = await service
    .from("skill_guides")
    .select("name,intent,preconditions,method_api,method_ui,gotchas,verification,stop_conditions,params")
    .limit(100);
  const routed = routeCoreSkillGuides(currentContent, recentUserContents);
  if (error || !data) {
    return {
      context: routed.names.length
        ? `\n\nRequired backend skill guides could not be loaded: ${routed.names.join(", ")}. Stop before execution and report that the guide library is unavailable.`
        : "",
      requestedNames: routed.names,
      loadedNames: [] as string[],
      missingNames: routed.names,
      source: routed.source
    };
  }

  const rows = data as SkillGuideContextRow[];
  const byName = new Map(rows.map((guide) => [guide.name, guide] as const));
  const selected: SkillGuideContextRow[] = [];
  for (const name of routed.names) {
    const guide = byName.get(name);
    if (guide && !selected.some((item) => item.name === guide.name)) selected.push(guide);
  }

  const rankedFallback = rows
    .filter((guide) => !selected.some((item) => item.name === guide.name))
    .map((guide) => ({ guide, score: guideKeywordScore(currentContent, guide) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.guide.name.localeCompare(b.guide.name))
    .map((item) => item.guide);

  for (const guide of rankedFallback) {
    if (selected.length >= 2) break;
    selected.push(guide);
  }

  const loadedNames = selected.map((guide) => guide.name);
  const missingNames = routed.names.filter((name) => !byName.has(name));
  const formatted = selected.map(formatGuideForContext);
  const missingWarning = missingNames.length
    ? `\n\nRequired routed skill guides are missing from the backend: ${missingNames.join(", ")}. Stop before that workflow and report that the Phase G guide seed must be applied.`
    : "";

  return {
    context:
      (formatted.length > 0
        ? `\n\nAutomatically loaded backend skill guides for this turn:\n\n${formatted.join("\n\n---\n\n")}`
        : "") + missingWarning,
    requestedNames: routed.names,
    loadedNames,
    missingNames,
    source: routed.source
  };
}

function skillGuideSummary(guide: SaveSkillGuideArgs, existingVersion: number | null): ApprovalSummaryRecord[] {
  return [
    {
      zoho_id: "skill_guide",
      name: guide.name,
      before: { version: existingVersion },
      after: {
        intent: guide.intent,
        params: guide.params.map((param) => param.name).join(", ") || "(none)",
        has_api_method: guide.method_api.trim().length > 0,
        has_ui_method: guide.method_ui.trim().length > 0
      }
    }
  ];
}

async function saveSkillGuide({
  service,
  user,
  sessionId,
  call,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const validated = validateSkillGuideToolCall(call);
  const guide = validated.args as SaveSkillGuideArgs;
  const { data: existing, error: existingError } = await service
    .from("skill_guides")
    .select("id,version")
    .eq("name", guide.name)
    .maybeSingle();
  if (existingError) throw existingError;

  const existingVersion = (existing as { id: string; version: number } | null)?.version ?? null;
  const summary = skillGuideSummary(guide, existingVersion);
  const { data: approval, error: approvalError } = await service
    .from("pending_approvals")
    .insert({
      session_id: sessionId,
      user_id: user.id,
      tool_name: "save_skill_guide",
      args: guide,
      summary,
      status: user.approvals_enabled ? "pending" : "approved",
      decided_at: user.approvals_enabled ? null : new Date().toISOString()
    })
    .select("id")
    .single();
  if (approvalError) throw approvalError;

  const approvalId = (approval as { id: string }).id;
  if (user.approvals_enabled) {
    await emit({ type: "approval_required", call_id: call.id, approval_id: approvalId, tool_name: "save_skill_guide", summary });
  }
  const decision = user.approvals_enabled
    ? await waitForApprovalOutcome({ service, approvalId, userId: user.id })
    : { outcome: "approved" as const, waitedMs: 0 };
  if (decision.outcome === "rejected" || decision.outcome === "expired") {
    return {
      ok: false,
      result: { approval_id: approvalId, status: decision.outcome, error: `The skill guide save was ${decision.outcome}.` },
      pausedMs: decision.waitedMs
    };
  }

  const payload = {
    ...guide,
    version: (existingVersion ?? 0) + 1
  };
  const query = existingVersion
    ? service.from("skill_guides").update(payload).eq("name", guide.name)
    : service.from("skill_guides").insert({ ...payload, created_by: user.id });
  const { data: saved, error: saveError } = await query
    .select("name,version,updated_at")
    .single();
  if (saveError) throw saveError;

  await service.from("audit_events").insert({
    user_id: user.id,
    event_type: existingVersion ? "skill_guide_updated" : "skill_guide_saved",
    message: `${existingVersion ? "Updated" : "Saved"} skill guide ${guide.name}.`,
    metadata: { session_id: sessionId, name: guide.name, version: payload.version }
  });

  return {
    ok: true,
    result: { approval_id: approvalId, status: "saved", auto_approved: !user.approvals_enabled, guide: saved },
    pausedMs: decision.waitedMs
  };
}

async function currentTeachMode(service: SupabaseClient, user: AuthorizedUser, sessionId: string) {
  const { data: sessionRow, error } = await service
    .from("agent_sessions")
    .select("teach_mode")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .single();
  if (error) throw error;
  return (sessionRow as { teach_mode?: boolean } | null)?.teach_mode === true;
}

async function activeTaskOrder(service: SupabaseClient, user: AuthorizedUser, sessionId: string) {
  const { data, error } = await service
    .from("task_orders")
    .select("id,session_id,user_id,goal,plan,scope,status,budget,decided_at,created_at")
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .eq("status", "approved")
    .maybeSingle();
  if (error) throw error;
  return data as ActiveTaskOrder | null;
}

async function taskOrderById(service: SupabaseClient, user: AuthorizedUser, id: string) {
  const { data, error } = await service
    .from("task_orders")
    .select("id,session_id,user_id,goal,plan,scope,status,budget,decided_at,created_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  return data as ActiveTaskOrder | null;
}

function taskOrderSummary(goal: string, planSummary: string, expectedChanges: ExpectedChange[]): ApprovalSummaryRecord[] {
  if (expectedChanges.length === 0) {
    return [
      {
        zoho_id: "task_order",
        name: goal,
        before: { status: "not started" },
        after: { plan: planSummary, expected_changes: 0 }
      }
    ];
  }
  return expectedChanges.map((change, index) => ({
    zoho_id: change.record || `expected_change_${index + 1}`,
    name: change.record || `Expected change ${index + 1}`,
    before: { status: "not started" },
    after: { action: change.action, detail: change.detail }
  }));
}

async function proposeTaskOrder({
  service,
  user,
  sessionId,
  call,
  userRequest,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  userRequest: string;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const validated = validateTaskOrderToolCall(call);
  const args = validated.args as {
    goal: string;
    plan_summary: string;
    expected_changes: ExpectedChange[];
    scope: "read" | "write";
  };
  const existing = await activeTaskOrder(service, user, sessionId);
  if (existing) {
    throw new Error(`Task order already active: ${existing.goal}. Complete or stop it before proposing another.`);
  }

  const proposal = taskOrderProposalDecision(args.expected_changes, userRequest);
  if (!proposal.allowed) throw new Error(proposal.reason);

  const budget = defaultTaskOrderBudget(args.expected_changes);
  const nowIso = new Date().toISOString();
  const { data: order, error } = await service
    .from("task_orders")
    .insert({
      session_id: sessionId,
      user_id: user.id,
      goal: args.goal,
      plan: {
        plan_summary: args.plan_summary,
        expected_changes: args.expected_changes
      },
      scope: args.scope,
      status: args.scope === "read" || !user.approvals_enabled ? "approved" : "proposed",
      budget,
      decided_at: args.scope === "read" || !user.approvals_enabled ? nowIso : null
    })
    .select("id,goal,scope,status,budget")
    .single();
  if (error) throw error;

  const taskOrderId = (order as { id: string }).id;
  await service.from("audit_events").insert({
    user_id: user.id,
    event_type: "task_order_proposed",
    message: `Task order proposed: ${args.goal}.`,
    metadata: { session_id: sessionId, task_order_id: taskOrderId, scope: args.scope, budget }
  });

  if (args.scope === "read" || !user.approvals_enabled) {
    return {
      ok: true,
      result: {
        task_order_id: taskOrderId,
        status: "approved",
        scope: args.scope,
        budget,
        auto_approved: args.scope !== "read" && !user.approvals_enabled
      },
      pausedMs: 0
    };
  }

  const summary = taskOrderSummary(args.goal, args.plan_summary, args.expected_changes);
  const { data: approval, error: approvalError } = await service
    .from("pending_approvals")
    .insert({
      session_id: sessionId,
      user_id: user.id,
      tool_name: "task_order",
      args: { task_order_id: taskOrderId, goal: args.goal, scope: args.scope },
      summary
    })
    .select("id")
    .single();
  if (approvalError) throw approvalError;

  const approvalId = (approval as { id: string }).id;
  await emit({
    type: "approval_required",
    call_id: call.id,
    approval_id: approvalId,
    tool_name: "task_order",
    summary
  });

  const decision = await waitForApprovalOutcome({ service, approvalId, userId: user.id });
  if (decision.outcome === "rejected" || decision.outcome === "expired") {
    await service
      .from("task_orders")
      .update({
        status: decision.outcome,
        decided_at: new Date().toISOString(),
        report: { status: decision.outcome, approval_id: approvalId }
      })
      .eq("id", taskOrderId)
      .eq("user_id", user.id)
      .eq("status", "proposed");
    return {
      ok: false,
      result: { approval_id: approvalId, task_order_id: taskOrderId, status: decision.outcome },
      pausedMs: decision.waitedMs
    };
  }

  return {
    ok: true,
    result: { approval_id: approvalId, task_order_id: taskOrderId, status: "approved", budget },
    pausedMs: decision.waitedMs
  };
}

async function completeTaskOrder({
  service,
  user,
  sessionId,
  call
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
}): Promise<{ ok: boolean; result: unknown }> {
  const validated = validateTaskOrderToolCall(call);
  const args = validated.args as { report: unknown };
  const order = await activeTaskOrder(service, user, sessionId);
  if (!order) throw new Error("No active approved task order to complete.");

  const report = typeof args.report === "string" ? { summary: args.report } : args.report;
  const completedAt = new Date().toISOString();
  const { data, error } = await service
    .from("task_orders")
    .update({ status: "completed", report, completed_at: completedAt })
    .eq("id", order.id)
    .eq("user_id", user.id)
    .eq("status", "approved")
    .select("id,goal,status,report,completed_at")
    .single();
  if (error) throw error;

  await service.from("audit_events").insert({
    user_id: user.id,
    event_type: "task_order_completed",
    message: `Task order completed: ${order.goal}.`,
    metadata: { session_id: sessionId, task_order_id: order.id }
  });

  return { ok: true, result: { task_order: data } };
}

async function failTaskOrder(service: SupabaseClient, user: AuthorizedUser, orderId: string, reason: string) {
  await service
    .from("task_orders")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      report: { status: "failed", reason }
    })
    .eq("id", orderId)
    .eq("user_id", user.id)
    .eq("status", "approved");
}

async function waitForToolJobById({
  service,
  jobId,
  userId
}: {
  service: SupabaseClient;
  jobId: string;
  userId: string;
}) {
  const started = Date.now();
  while (Date.now() - started < agentTurnTimeoutMs()) {
    const { data, error } = await service
      .from("tool_jobs")
      .select("id,status,result,error_message")
      .eq("id", jobId)
      .eq("user_id", userId)
      .single();
    if (error) throw error;
    const row = data as { status: string; result: unknown; error_message: string | null };
    if (row.status === "done") return { ok: true, result: row.result, waitedMs: Date.now() - started };
    if (row.status === "failed" || row.status === "expired") {
      return {
        ok: false,
        result: { status: row.status, error: row.error_message ?? "Task-order job failed.", result: row.result },
        waitedMs: Date.now() - started
      };
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }
  await service
    .from("tool_jobs")
    .update({
      status: "expired",
      completed_at: new Date().toISOString(),
      error_message: "Timed out waiting for the Chrome extension to report this task-order job."
    })
    .eq("id", jobId)
    .eq("user_id", userId)
    .in("status", ["queued", "running"]);
  return { ok: false, result: { status: "expired", error: "Task-order job timed out." }, waitedMs: Date.now() - started };
}

function databaseScheduleTime(value: string) {
  const raw = value.trim().toUpperCase();
  const twelveHour = /^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/.exec(raw);
  if (!twelveHour) return /^([01]?\d|2[0-3]):[0-5]\d$/.test(raw) ? `${raw.padStart(5, "0")}:00` : raw;
  let hour = Number(twelveHour[1]);
  if (twelveHour[3] === "AM" && hour === 12) hour = 0;
  if (twelveHour[3] === "PM" && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, "0")}:${twelveHour[2]}:00`;
}

async function runEmailSchedulingBatch({
  service,
  user,
  sessionId,
  call,
  order,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  order: ActiveTaskOrder | null;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const validated = validateEmailSchedulingToolCall(call);
  const args = validated.args as { emails: ResolvedEmailScheduleItem[] };
  if (args.emails.length > 3 && !order) {
    throw new Error("Scheduling more than 3 emails requires an approved task order before calling schedule_zoho_email_batch.");
  }

  const resolution = await resolveEmailScheduleBatch(service, validated.args);
  const resolved = resolution.filter((row): row is { ok: true; item: ResolvedEmailScheduleItem } => row.ok);
  const unresolved = resolution.filter((row) => !row.ok);
  if (resolved.length === 0) {
    return { ok: false, result: { status: "not_started", resolved: 0, failures: unresolved }, pausedMs: 0 };
  }
  if (order && resolved.length > order.budget.max_records_touched) {
    throw new Error(`Resolved batch exceeds task-order record budget (${order.budget.max_records_touched}).`);
  }

  const summary: ApprovalSummaryRecord[] = resolved.map(({ item }) => ({
    zoho_id: item.deal_zoho_id,
    name: `${item.contact_name} - ${item.deal_name}`,
    before: { scheduled: false },
    after: {
      action: "schedule_email",
      to: item.to,
      cc: item.cc,
      subject: item.subject,
      schedule_date: item.schedule_date,
      schedule_time: item.schedule_time,
      timezone: item.timezone,
      preserve_signature: true
    }
  }));

  let approvalId: string | null = null;
  let pausedMs = 0;
  if (!order) {
    const snapshot = { tool_name: "schedule_zoho_email_batch", emails: resolved.map((row) => row.item) };
    const { data: approval, error } = await service
      .from("pending_approvals")
      .insert({
        session_id: sessionId,
        user_id: user.id,
        tool_name: snapshot.tool_name,
        args: snapshot,
        summary,
        status: user.approvals_enabled ? "pending" : "approved",
        decided_at: user.approvals_enabled ? null : new Date().toISOString()
      })
      .select("id")
      .single();
    if (error) throw error;
    approvalId = (approval as { id: string }).id;
    if (user.approvals_enabled) {
      await emit({
        type: "approval_required",
        call_id: call.id,
        approval_id: approvalId,
        tool_name: "schedule_zoho_email_batch",
        summary
      });
      const decision = await waitForApprovalOutcome({ service, approvalId, userId: user.id });
      pausedMs += decision.waitedMs;
      if (decision.outcome !== "approved") {
        return {
          ok: false,
          result: { approval_id: approvalId, status: decision.outcome, failures: unresolved },
          pausedMs
        };
      }
    }
  }

  const outcomes: Array<Record<string, unknown>> = unresolved.map((failure) => ({
    reference: failure.reference,
    status: "not_started",
    error: failure.error,
    candidates: failure.candidates ?? []
  }));
  let consecutiveFailures = 0;
  let executed = 0;
  let failed = unresolved.length;
  const startedAt = Date.now();

  for (const { item } of resolved) {
    if (order) {
      const { data: currentOrder, error: orderError } = await service
        .from("task_orders")
        .select("status")
        .eq("id", order.id)
        .eq("user_id", user.id)
        .single();
      if (orderError) throw orderError;
      if ((currentOrder as { status: string }).status !== "approved") {
        outcomes.push({ reference: item.reference, status: "not_started", error: "Task order was stopped." });
        break;
      }
      if (executed >= order.budget.max_tool_calls) {
        outcomes.push({ reference: item.reference, status: "not_started", error: "Task-order tool-call budget reached." });
        break;
      }
      if (Date.now() - startedAt > order.budget.max_wall_ms) {
        outcomes.push({ reference: item.reference, status: "not_started", error: "Task-order wall-clock budget reached." });
        break;
      }
    }

    const scheduleTime = databaseScheduleTime(item.schedule_time);
    const { data: duplicate, error: duplicateError } = await service
      .from("scheduled_emails")
      .select("id,zoho_url")
      .eq("related_deal_id", item.deal_id)
      .eq("related_contact_id", item.contact_id)
      .ilike("to_email", item.to)
      .eq("subject", item.subject)
      .eq("schedule_date", item.schedule_date)
      .eq("schedule_time", scheduleTime)
      .eq("status", "scheduled")
      .maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      outcomes.push({
        reference: item.reference,
        status: "already_scheduled",
        deal_url: item.deal_url,
        scheduled_email_id: (duplicate as { id: string }).id
      });
      consecutiveFailures = 0;
      continue;
    }

    const { data: inserted, error: insertError } = await service
      .from("tool_jobs")
      .insert({
        user_id: user.id,
        session_id: sessionId,
        tool_name: "schedule_zoho_email",
        args: item,
        ...(order ? { task_order_id: order.id } : { approval_id: approvalId })
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    await service.from("audit_events").insert({
      user_id: user.id,
      event_type: "deterministic_email_queued",
      message: `Queued deterministic email schedule for ${item.reference}.`,
      metadata: {
        session_id: sessionId,
        task_order_id: order?.id ?? null,
        approval_id: approvalId,
        deal_id: item.deal_zoho_id,
        reference: item.reference
      }
    });
    await emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status: "queued" });
    const job = await waitForToolJobById({ service, jobId: (inserted as { id: string }).id, userId: user.id });
    pausedMs += job.waitedMs;
    executed += 1;

    if (job.ok) {
      consecutiveFailures = 0;
      const result = job.result as Record<string, unknown> | null;
      outcomes.push({ reference: item.reference, status: "scheduled", deal_url: item.deal_url, result });
      const { error: emailLogError } = await service.from("scheduled_emails").insert({
        related_deal_id: item.deal_id,
        related_contact_id: item.contact_id,
        to_email: item.to,
        cc_emails: item.cc,
        subject: item.subject,
        body_hash: createHash("sha256").update(item.body, "utf8").digest("hex"),
        schedule_date: item.schedule_date,
        schedule_time: scheduleTime,
        status: "scheduled",
        zoho_url: item.deal_url,
        raw_data: result ?? {}
      });
      if (emailLogError) throw emailLogError;
    } else {
      consecutiveFailures += 1;
      failed += 1;
      outcomes.push({ reference: item.reference, status: "failed", deal_url: item.deal_url, result: job.result });
    }

    await service.from("audit_events").insert({
      user_id: user.id,
      event_type: "deterministic_email_completed",
      message: `${job.ok ? "Scheduled" : "Failed"} deterministic email for ${item.reference}.`,
      metadata: {
        session_id: sessionId,
        task_order_id: order?.id ?? null,
        approval_id: approvalId,
        deal_id: item.deal_zoho_id,
        reference: item.reference,
        ok: job.ok
      }
    });

    const processed = executed + unresolved.length;
    if (consecutiveFailures >= 3 || (processed >= 5 && failed / processed > 0.2)) break;
  }

  const scheduled = outcomes.filter((row) => row.status === "scheduled").length;
  const alreadyScheduled = outcomes.filter((row) => row.status === "already_scheduled").length;
  const failures = outcomes.filter((row) => row.status === "failed" || row.status === "not_started").length;
  return {
    ok: failures === 0,
    result: {
      status: failures === 0 ? "completed" : scheduled + alreadyScheduled > 0 ? "partial" : "failed",
      task_order_id: order?.id ?? null,
      approval_id: approvalId,
      counts: { requested: validated.args.emails.length, scheduled, already_scheduled: alreadyScheduled, failures },
      records: outcomes,
      expected_vs_actual: { expected: validated.args.emails.length, accounted_for: outcomes.length }
    },
    pausedMs
  };
}

async function runTier2UnderTaskOrder({
  supabase,
  service,
  user,
  sessionId,
  call,
  order,
  emit
}: {
  supabase: SupabaseClient;
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  order: ActiveTaskOrder;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const moduleGuess = normalizeModule((call.args as { module?: unknown })?.module);
  const { data: metaRows } = moduleGuess
    ? await service
        .from("zoho_field_meta")
        .select("module,api_name,data_type,picklist_values")
        .eq("module", moduleGuess)
    : { data: [] as Array<{ module: string; api_name: string; data_type: string | null; picklist_values: unknown }> };
  const prepared = validateTier2Call(call, { fieldMeta: metaRows ?? [], role: user.role });
  const liveFetch = makeLiveFetch(service, user, sessionId);
  const { summary, snapshot } = await buildApprovalRequest({ supabase, prepared, liveFetch });
  const approvalId = await createPendingApproval({
    service,
    sessionId,
    userId: user.id,
    snapshot,
    summary,
    status: "approved",
    taskOrderId: order.id
  });

  const { data: inserted, error } = await service
    .from("tool_jobs")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      tool_name: snapshot.tool_name,
      args: snapshot,
      task_order_id: order.id,
      approval_id: approvalId
    })
    .select("id")
    .single();
  if (error) throw error;

  await emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status: "queued" });
  const job = await waitForToolJobById({ service, jobId: (inserted as { id: string }).id, userId: user.id });
  const followup = verifiedWriteFollowup({ ok: job.ok, snapshot });
  return {
    ok: job.ok,
    result: {
      task_order_id: order.id,
      approval_id: approvalId,
      status: job.ok ? "executed" : "failed",
      ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result }),
      ...(followup ?? {})
    },
    pausedMs: job.waitedMs
  };
}

async function runUiStepUnderTaskOrder({
  service,
  user,
  sessionId,
  call,
  order,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  order: ActiveTaskOrder;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const validatedCall = validateUiToolCall(call);
  const { data: inserted, error } = await service
    .from("tool_jobs")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      tool_name: validatedCall.name,
      args: validatedCall.args,
      task_order_id: order.id
    })
    .select("id")
    .single();
  if (error) throw error;

  await emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status: "queued" });
  const job = await waitForToolJobById({ service, jobId: (inserted as { id: string }).id, userId: user.id });
  return {
    ok: job.ok,
    result: {
      task_order_id: order.id,
      ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result })
    },
    pausedMs: job.waitedMs
  };
}

function codeHash(code: string) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function browserEvalSummary(args: BrowserEvalArgs): ApprovalSummaryRecord[] {
  return [
    {
      zoho_id: "browser_eval",
      name: args.purpose,
      before: { status: "not executed" },
      after: {
        purpose: args.purpose,
        code_sha256: codeHash(args.code),
        code_bytes: Buffer.byteLength(args.code, "utf8"),
        code: args.code
      }
    }
  ];
}

async function enqueueBrowserEval({
  service,
  user,
  sessionId,
  call,
  args,
  taskOrderId,
  approvalId,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  args: BrowserEvalArgs;
  taskOrderId?: string | null;
  approvalId?: string | null;
  emit: Emit;
}) {
  const hash = codeHash(args.code);
  await service.from("audit_events").insert({
    user_id: user.id,
    event_type: "browser_eval_queued",
    message: `Queued browser_eval: ${args.purpose}.`,
    metadata: {
      session_id: sessionId,
      purpose: args.purpose,
      code_sha256: hash,
      code_bytes: Buffer.byteLength(args.code, "utf8"),
      task_order_id: taskOrderId ?? null,
      approval_id: approvalId ?? null
    }
  });

  const { data: inserted, error } = await service
    .from("tool_jobs")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      tool_name: "browser_eval",
      args,
      ...(taskOrderId ? { task_order_id: taskOrderId } : {}),
      ...(approvalId ? { approval_id: approvalId } : {})
    })
    .select("id")
    .single();
  if (error) throw error;

  await emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status: "queued" });
  const job = await waitForToolJobById({ service, jobId: (inserted as { id: string }).id, userId: user.id });
  await service.from("audit_events").insert({
    user_id: user.id,
    event_type: "browser_eval_completed",
    message: `${job.ok ? "Completed" : "Failed"} browser_eval: ${args.purpose}.`,
    metadata: {
      session_id: sessionId,
      purpose: args.purpose,
      code_sha256: hash,
      code_bytes: Buffer.byteLength(args.code, "utf8"),
      task_order_id: taskOrderId ?? null,
      approval_id: approvalId ?? null,
      ok: job.ok
    }
  });
  return job;
}

async function runBrowserEvalTool({
  service,
  user,
  sessionId,
  call,
  order,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  order: ActiveTaskOrder | null;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const validated = validateBrowserToolCall(call);
  const args = validated.args as BrowserEvalArgs;

  if (order) {
    const job = await enqueueBrowserEval({
      service,
      user,
      sessionId,
      call,
      args,
      taskOrderId: order.id,
      emit
    });
    return {
      ok: job.ok,
      result: {
        task_order_id: order.id,
        code_sha256: codeHash(args.code),
        ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result })
      },
      pausedMs: job.waitedMs
    };
  }

  if (!user.approvals_enabled) {
    const job = await enqueueBrowserEval({
      service,
      user,
      sessionId,
      call,
      args,
      emit
    });
    return {
      ok: job.ok,
      result: {
        status: job.ok ? "executed" : "failed",
        code_sha256: codeHash(args.code),
        auto_approved: true,
        ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result })
      },
      pausedMs: job.waitedMs
    };
  }

  const summary = browserEvalSummary(args);
  const { data: approval, error: approvalError } = await service
    .from("pending_approvals")
    .insert({
      session_id: sessionId,
      user_id: user.id,
      tool_name: "browser_eval",
      args,
      summary
    })
    .select("id")
    .single();
  if (approvalError) throw approvalError;

  const approvalId = (approval as { id: string }).id;
  await emit({
    type: "approval_required",
    call_id: call.id,
    approval_id: approvalId,
    tool_name: "browser_eval",
    summary
  });
  const decision = await waitForApprovalOutcome({ service, approvalId, userId: user.id });
  if (decision.outcome === "rejected" || decision.outcome === "expired") {
    return {
      ok: false,
      result: { approval_id: approvalId, status: decision.outcome, code_sha256: codeHash(args.code) },
      pausedMs: decision.waitedMs
    };
  }

  const job = await enqueueBrowserEval({
    service,
    user,
    sessionId,
    call,
    args,
    approvalId,
    emit
  });
  return {
    ok: job.ok,
    result: {
      approval_id: approvalId,
      code_sha256: codeHash(args.code),
      ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result })
    },
    pausedMs: decision.waitedMs + job.waitedMs
  };
}

function instructionsForTurn(teachMode: boolean, approvalsEnabled: boolean, guideContext: string) {
  return `${AGENT_INSTRUCTIONS}

Current session state: teach_mode is ${teachMode ? "ON" : "OFF"}; approval cards are ${
    approvalsEnabled ? "ON" : "OFF"
  }. Watched browser work can use browser_observe, ui_step, and browser_eval immediately, then verify honestly. ${
    approvalsEnabled
      ? "When approval cards are ON, unattended/batch task orders and Tier-2 API writes pause for cards."
      : "When approval cards are OFF, batch task orders auto-approve as work logs and Tier-2 API writes run immediately with before/after evidence."
  }${guideContext}`;
}

async function ensureTeachMode(service: SupabaseClient, user: AuthorizedUser, sessionId: string) {
  const decision = uiStepTeachModeDecision(await currentTeachMode(service, user, sessionId));
  if (!decision.allowed) throw new Error(decision.reason);
}

async function saveUiWorkflow({
  service,
  user,
  sessionId,
  call,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  await ensureTeachMode(service, user, sessionId);
  const validatedCall = validateUiToolCall(call);
  const workflow = validatedCall.args as PreparedUiWorkflow;

  const { data: existing, error: existingError } = await service
    .from("ui_workflows")
    .select("id,version")
    .eq("name", workflow.name)
    .maybeSingle();
  if (existingError) throw existingError;

  const existingVersion = (existing as { id: string; version: number } | null)?.version ?? null;
  const summary = workflowSummary(workflow, existingVersion);
  const { data: approval, error: approvalError } = await service
    .from("pending_approvals")
    .insert({
      session_id: sessionId,
      user_id: user.id,
      tool_name: "save_ui_workflow",
      args: workflow,
      summary,
      status: user.approvals_enabled ? "pending" : "approved",
      decided_at: user.approvals_enabled ? null : new Date().toISOString()
    })
    .select("id")
    .single();
  if (approvalError) throw approvalError;

  const approvalId = (approval as { id: string }).id;
  if (user.approvals_enabled) {
    await emit({
      type: "approval_required",
      call_id: call.id,
      approval_id: approvalId,
      tool_name: "save_ui_workflow",
      summary
    });
  }

  const decision = user.approvals_enabled
    ? await waitForApprovalOutcome({ service, approvalId, userId: user.id })
    : { outcome: "approved" as const, waitedMs: 0 };
  if (decision.outcome === "rejected") {
    return {
      ok: false,
      result: { approval_id: approvalId, status: "rejected", error: "The user rejected this workflow save." },
      pausedMs: decision.waitedMs
    };
  }
  if (decision.outcome === "expired") {
    return {
      ok: false,
      result: { approval_id: approvalId, status: "expired", error: "The workflow save approval expired." },
      pausedMs: decision.waitedMs
    };
  }

  const payload = {
    name: workflow.name,
    description: workflow.description,
    params: workflow.params,
    steps: workflow.steps,
    effect: workflow.effect,
    trusted: false,
    version: (existingVersion ?? 0) + 1
  };
  const query = existingVersion
    ? service.from("ui_workflows").update(payload).eq("name", workflow.name)
    : service.from("ui_workflows").insert({ ...payload, created_by: user.id });

  const { data: saved, error: saveError } = await query
    .select("name,effect,trusted,version,updated_at")
    .single();
  if (saveError) throw saveError;

  await service.from("audit_events").insert({
    user_id: user.id,
    event_type: existingVersion ? "workflow_updated" : "workflow_saved",
    message: `${existingVersion ? "Updated" : "Saved"} UI workflow ${workflow.name}.`,
    metadata: {
      name: workflow.name,
      effect: workflow.effect,
      version: payload.version,
      source: "agent_save_ui_workflow"
    }
  });

  return {
    ok: true,
    result: { approval_id: approvalId, status: "saved", auto_approved: !user.approvals_enabled, workflow: saved },
    pausedMs: decision.waitedMs
  };
}

function workflowReplaySucceeded(result: unknown) {
  return Boolean(result && typeof result === "object" && (result as { ok?: unknown }).ok === true);
}

function describeUiStep(step: Record<string, unknown>) {
  const out: Record<string, unknown> = { type: step.type };
  for (const key of ["url", "text", "selector", "value", "equals", "key", "press_enter"]) {
    if (Object.hasOwn(step, key)) out[key] = step[key];
  }
  return out;
}

function workflowReplaySummary(name: string, steps: Array<Record<string, unknown>>): ApprovalSummaryRecord[] {
  return steps.map((step, index) => ({
    zoho_id: `workflow_step_${index + 1}`,
    name: `${index + 1}. ${String(step.type ?? "step")}`,
    before: { workflow: name, status: "not executed" },
    after: describeUiStep(step)
  }));
}

async function markWorkflowTrusted(
  service: SupabaseClient,
  replay: { name: string; version: number; trusted: boolean },
  result: unknown
) {
  const verified = workflowReplaySucceeded(result);
  if (verified && !replay.trusted) {
    await service
      .from("ui_workflows")
      .update({ trusted: true })
      .eq("name", replay.name)
      .eq("version", replay.version);
  }
  return verified;
}

async function runUiWorkflowTool({
  service,
  user,
  sessionId,
  call,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  emit: Emit;
}): Promise<{ ok: boolean; result: unknown; pausedMs: number }> {
  const validatedCall = validateUiToolCall(call);
  const args = validatedCall.args as RunUiWorkflowArgs;
  const { data: workflowRow, error } = await service
    .from("ui_workflows")
    .select("name,description,params,steps,effect,trusted,version")
    .eq("name", args.name)
    .maybeSingle();
  if (error) throw error;
  if (!workflowRow) throw new Error(`Workflow "${args.name}" was not found.`);

  const replay = prepareUiWorkflowReplay(workflowRow as SavedUiWorkflow, args);
  const jobCall: AgentToolCall = {
    id: call.id,
    name: "ui_workflow",
    args: {
      name: replay.name,
      effect: replay.effect,
      trusted_before: replay.trusted,
      version: replay.version,
      steps: replay.steps
    }
  };

  if (replay.effect === "write") {
    const summary = workflowReplaySummary(replay.name, replay.steps as Array<Record<string, unknown>>);
    const { data: approval, error: approvalError } = await service
      .from("pending_approvals")
      .insert({
        session_id: sessionId,
        user_id: user.id,
        tool_name: "ui_workflow",
        args: jobCall.args,
        summary,
        status: user.approvals_enabled ? "pending" : "approved",
        decided_at: user.approvals_enabled ? null : new Date().toISOString()
      })
      .select("id")
      .single();
    if (approvalError) throw approvalError;

    const approvalId = (approval as { id: string }).id;
    if (!user.approvals_enabled) {
      const { error: jobError } = await service.from("tool_jobs").insert({
        user_id: user.id,
        session_id: sessionId,
        tool_name: "ui_workflow",
        args: jobCall.args,
        approval_id: approvalId
      });
      if (jobError) throw jobError;
      await emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status: "queued" });
      const job = await waitForApprovalJob({ service, approvalId, userId: user.id });
      const verified = await markWorkflowTrusted(service, replay, job.result);
      const replayOk = job.ok && verified;
      return {
        ok: replayOk,
        result: {
          approval_id: approvalId,
          status: replayOk ? "executed" : "failed",
          auto_approved: true,
          ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result }),
          trusted_before: replay.trusted,
          trusted_after: verified ? true : replay.trusted
        },
        pausedMs: job.waitedMs
      };
    }

    await emit({
      type: "approval_required",
      call_id: call.id,
      approval_id: approvalId,
      tool_name: "ui_workflow",
      summary
    });

    const decision = await waitForApprovalOutcome({ service, approvalId, userId: user.id });
    if (decision.outcome === "rejected") {
      return {
        ok: false,
        result: { approval_id: approvalId, status: "rejected", error: "The user rejected this workflow replay." },
        pausedMs: decision.waitedMs
      };
    }
    if (decision.outcome === "expired") {
      return {
        ok: false,
        result: { approval_id: approvalId, status: "expired", error: "The workflow replay approval expired." },
        pausedMs: decision.waitedMs
      };
    }

    const job = await waitForApprovalJob({ service, approvalId, userId: user.id });
    const verified = await markWorkflowTrusted(service, replay, job.result);
    // The job may report "done" while the workflow itself failed mid-step
    // (inner ok:false with failed_step_index). Only a fully verified replay
    // counts as an executed success; anything else is reported as failed so
    // the trace and the model cannot claim success for a failed replay.
    const replayOk = job.ok && verified;
    return {
      ok: replayOk,
      result: {
        approval_id: approvalId,
        status: replayOk ? "executed" : "failed",
        ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result }),
        trusted_before: replay.trusted,
        trusted_after: verified ? true : replay.trusted
      },
      pausedMs: decision.waitedMs + job.waitedMs
    };
  }

  const bridgedResult = await runBridgedTool({
    service,
    user,
    sessionId,
    call: jobCall,
    onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
  });

  const verified = await markWorkflowTrusted(service, replay, bridgedResult);

  // Same honesty rule as the write path: a bridged job can complete while the
  // workflow failed mid-step. Report ok only for a fully verified replay.
  return {
    ok: verified,
    result: {
      ...(bridgedResult && typeof bridgedResult === "object" ? (bridgedResult as Record<string, unknown>) : { result: bridgedResult }),
      trusted_before: replay.trusted,
      trusted_after: verified ? true : replay.trusted,
      warning: replay.trusted ? null : "This workflow was untrusted before replay; a fully verified replay marks it trusted."
    },
    pausedMs: 0
  };
}

type PendingApprovalUndoRow = {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
  summary: ApprovalSummaryRecord[] | null;
  task_order_id: string | null;
  created_at: string;
};

type UndoAction = {
  source_approval_id: string;
  module: Tier2Module;
  zoho_id: string;
  description: string;
  call: AgentToolCall;
};

function isKnownBeforeValue(value: unknown) {
  return value !== "unknown - verify in card" && value !== undefined;
}

function moduleFromApproval(row: PendingApprovalUndoRow): Tier2Module | null {
  const moduleValue = row.args?.module;
  return moduleValue === "Accounts" || moduleValue === "Contacts" || moduleValue === "Deals" ? moduleValue : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function undoActionsFromApproval(row: PendingApprovalUndoRow, filter?: { zohoId?: string; fields?: string[] }) {
  const moduleName = moduleFromApproval(row);
  if (!moduleName) return { actions: [] as UndoAction[], skipped: [`${row.id}: missing supported module.`] };

  const fieldFilter = filter?.fields ? new Set(filter.fields) : null;
  const actions: UndoAction[] = [];
  const skipped: string[] = [];
  for (const item of row.summary ?? []) {
    if (filter?.zohoId && item.zoho_id !== filter.zohoId) continue;

    if (row.tool_name === "zoho_update_fields") {
      const fields: Record<string, string | number | boolean | null> = {};
      for (const [field, value] of Object.entries(item.before ?? {})) {
        if (fieldFilter && !fieldFilter.has(field)) continue;
        if (!isKnownBeforeValue(value)) {
          skipped.push(`${item.zoho_id}: ${field} had no logged before-value.`);
          continue;
        }
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
          fields[field] = value as string | number | boolean | null;
        } else {
          skipped.push(`${item.zoho_id}: ${field} before-value is not a simple field value.`);
        }
      }
      if (Object.keys(fields).length > 0) {
        actions.push({
          source_approval_id: row.id,
          module: moduleName,
          zoho_id: item.zoho_id,
          description: `Revert fields ${Object.keys(fields).join(", ")} on ${item.zoho_id}.`,
          call: {
            id: `undo-fields-${row.id}-${item.zoho_id}`,
            name: "zoho_update_fields",
            args: { module: moduleName, updates: [{ zoho_id: item.zoho_id, fields }] }
          }
        });
      }
      continue;
    }

    if (row.tool_name === "zoho_change_owner") {
      const owner = item.before?.Owner;
      if (typeof owner === "string" && owner.trim() && isKnownBeforeValue(owner)) {
        actions.push({
          source_approval_id: row.id,
          module: moduleName,
          zoho_id: item.zoho_id,
          description: `Revert owner on ${item.zoho_id} to ${owner}.`,
          call: {
            id: `undo-owner-${row.id}-${item.zoho_id}`,
            name: "zoho_change_owner",
            args: { module: moduleName, zoho_ids: [item.zoho_id], owner_name: owner }
          }
        });
      } else {
        skipped.push(`${item.zoho_id}: owner had no logged before-value.`);
      }
      continue;
    }

    if (row.tool_name === "zoho_add_tags") {
      const beforeTags = stringArray(item.before?.tags);
      const addedTags = stringArray(item.after?.add).filter((tag) => !beforeTags.includes(tag));
      if (beforeTags.length === 0 && !Array.isArray(item.before?.tags)) {
        skipped.push(`${item.zoho_id}: tags had no logged before-value.`);
      }
      if (addedTags.length > 0) {
        actions.push({
          source_approval_id: row.id,
          module: moduleName,
          zoho_id: item.zoho_id,
          description: `Remove tags ${addedTags.join(", ")} from ${item.zoho_id}.`,
          call: {
            id: `undo-add-tags-${row.id}-${item.zoho_id}`,
            name: "zoho_remove_tags",
            args: { module: moduleName, zoho_ids: [item.zoho_id], tags: addedTags }
          }
        });
      }
      continue;
    }

    if (row.tool_name === "zoho_remove_tags") {
      const beforeTags = stringArray(item.before?.tags);
      const removedTags = stringArray(item.after?.remove).filter((tag) => beforeTags.includes(tag));
      if (beforeTags.length === 0 && !Array.isArray(item.before?.tags)) {
        skipped.push(`${item.zoho_id}: tags had no logged before-value.`);
      }
      if (removedTags.length > 0) {
        actions.push({
          source_approval_id: row.id,
          module: moduleName,
          zoho_id: item.zoho_id,
          description: `Add tags ${removedTags.join(", ")} back to ${item.zoho_id}.`,
          call: {
            id: `undo-remove-tags-${row.id}-${item.zoho_id}`,
            name: "zoho_add_tags",
            args: { module: moduleName, zoho_ids: [item.zoho_id], tags: removedTags }
          }
        });
      }
    }
  }
  return { actions, skipped };
}

async function executeUndoActions({
  supabase,
  service,
  user,
  sessionId,
  emit,
  actions
}: {
  supabase: SupabaseClient;
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  emit: Emit;
  actions: UndoAction[];
}) {
  const results: unknown[] = [];
  let pausedMs = 0;
  for (const action of actions) {
    const outcome = await handleTier2Call({ supabase, service, user, sessionId, call: action.call, emit });
    pausedMs += outcome.pausedMs;
    results.push({
      source_approval_id: action.source_approval_id,
      zoho_id: action.zoho_id,
      description: action.description,
      ok: outcome.ok,
      result: outcome.result
    });
    await service.from("audit_events").insert({
      user_id: user.id,
      event_type: "undo",
      message: `${outcome.ok ? "Ran" : "Failed"} undo: ${action.description}`,
      metadata: {
        session_id: sessionId,
        source_approval_id: action.source_approval_id,
        module: action.module,
        zoho_id: action.zoho_id,
        ok: outcome.ok
      }
    });
  }
  return { results, pausedMs, ok: results.every((item) => (item as { ok?: unknown }).ok === true) };
}

async function undoRecord({
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
  const validated = validateUndoToolCall(call);
  const args = validated.args as UndoRecordArgs;
  const { data, error } = await service
    .from("pending_approvals")
    .select("id,tool_name,args,summary,task_order_id,created_at")
    .eq("user_id", user.id)
    .eq("status", "approved")
    .in("tool_name", ["zoho_update_fields", "zoho_change_owner", "zoho_add_tags", "zoho_remove_tags"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  const skipped: string[] = [];
  let selected: { row: PendingApprovalUndoRow; actions: UndoAction[] } | null = null;
  for (const row of (data ?? []) as PendingApprovalUndoRow[]) {
    if (moduleFromApproval(row) !== args.module) continue;
    const built = undoActionsFromApproval(row, { zohoId: args.zoho_id, fields: args.fields });
    skipped.push(...built.skipped);
    if (built.actions.length > 0) {
      selected = { row, actions: built.actions };
      break;
    }
  }

  if (!selected) {
    return {
      ok: false,
      result: {
        status: "not_revertible",
        error: "No revertible logged before-values were found for this record.",
        skipped
      },
      pausedMs: 0
    };
  }

  const executed = await executeUndoActions({ supabase, service, user, sessionId, emit, actions: selected.actions });
  return {
    ok: executed.ok,
    result: {
      status: executed.ok ? "undone" : "partial",
      source_approval_id: selected.row.id,
      actions: executed.results,
      skipped
    },
    pausedMs: executed.pausedMs
  };
}

async function undoTask({
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
  const validated = validateUndoToolCall(call);
  const args = validated.args as UndoTaskArgs;
  const { data: order, error: orderError } = await service
    .from("task_orders")
    .select("id,goal,report")
    .eq("id", args.task_order_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (orderError) throw orderError;
  if (!order) throw new Error("Task order was not found.");

  const { data, error } = await service
    .from("pending_approvals")
    .select("id,tool_name,args,summary,task_order_id,created_at")
    .eq("user_id", user.id)
    .eq("status", "approved")
    .eq("task_order_id", args.task_order_id)
    .in("tool_name", ["zoho_update_fields", "zoho_change_owner", "zoho_add_tags", "zoho_remove_tags"])
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;

  const skipped: string[] = [];
  const actions: UndoAction[] = [];
  for (const row of (data ?? []) as PendingApprovalUndoRow[]) {
    const built = undoActionsFromApproval(row);
    actions.push(...built.actions);
    skipped.push(...built.skipped);
  }

  const reportText = JSON.stringify((order as { report?: unknown }).report ?? "").toLowerCase();
  const nonRevertible =
    reportText.includes("email") || reportText.includes("schedule")
      ? [
          "Scheduled emails are not automatically revertible in scope. Manual path: open the related deal, Emails, Scheduled tab, find the matching recipient/subject/time, then cancel/delete it in Zoho UI."
        ]
      : [];

  if (actions.length === 0) {
    return {
      ok: nonRevertible.length === 0 ? false : true,
      result: {
        task_order_id: args.task_order_id,
        status: "nothing_revertible",
        actions: [],
        skipped,
        non_revertible: nonRevertible
      },
      pausedMs: 0
    };
  }

  const executed = await executeUndoActions({ supabase, service, user, sessionId, emit, actions });
  return {
    ok: executed.ok,
    result: {
      task_order_id: args.task_order_id,
      status: executed.ok ? "undone" : "partial",
      actions: executed.results,
      skipped,
      non_revertible: nonRevertible
    },
    pausedMs: executed.pausedMs
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

  const messageRows = (rows ?? []) as AgentMessageRow[];
  const transcript = messageRowsToPrompt(messageRows);
  const allUserContents = messageRows
    .filter((row) => row.role === "user" && row.content?.trim())
    .map((row) => row.content as string);
  const recentUserContents =
    allUserContents.at(-1) === content ? allUserContents.slice(-6, -1) : allUserContents.slice(-5);
  const guideRouting = service
    ? await guideContextForTurn(service, content, recentUserContents)
    : { context: "", requestedNames: [], loadedNames: [], missingNames: [], source: "none" as const };
  const automaticGuideContext = guideRouting.context;
  if (service && (guideRouting.requestedNames.length > 0 || guideRouting.loadedNames.length > 0)) {
    await service.from("audit_events").insert({
      user_id: user.id,
      event_type: "skill_guides_loaded",
      message: guideRouting.loadedNames.length
        ? `Loaded backend skill guides: ${guideRouting.loadedNames.join(", ")}.`
        : "No matching backend skill guide was loaded.",
      metadata: {
        session_id: sessionId,
        route_source: guideRouting.source,
        requested_guides: guideRouting.requestedNames,
        loaded_guides: guideRouting.loadedNames,
        missing_guides: guideRouting.missingNames
      }
    });
  }
  let toolCallCount = 0;
  // Time spent blocked on a Tier-2 approval card does NOT count against the
  // turn budget (a human may take minutes to decide). We subtract it.
  let pausedMs = 0;
  const turnTimeoutMs = agentTurnTimeoutMs();
  const maxToolCalls = agentMaxToolCalls();
  let effectiveTurnTimeoutMs = turnTimeoutMs;
  let effectiveMaxToolCalls = maxToolCalls;
  let activeTaskOrderId: string | null = null;
  let taskOrderToolCalls = 0;
  let taskOrderRecordsTouched = 0;
  let taskPreparationRecoveryBlocked = false;

  while (Date.now() - started - pausedMs < effectiveTurnTimeoutMs) {
    let approvedOrder: ActiveTaskOrder | null = null;
    if (service) {
      if (activeTaskOrderId) {
        const tracked = await taskOrderById(service, user, activeTaskOrderId);
        if (!tracked || tracked.status !== "approved") {
          const message = "Stopped because the active task order is no longer approved.";
          await supabase.from("agent_messages").insert({
            session_id: sessionId,
            role: "assistant",
            content: message
          });
          await emit({ type: "assistant_delta", text: message });
          await emit({ type: "done" });
          return;
        }
        approvedOrder = tracked;
      } else {
        approvedOrder = await activeTaskOrder(service, user, sessionId);
        activeTaskOrderId = approvedOrder?.id ?? null;
      }
      if (approvedOrder) {
        const expandedLimits = expandedAgentLimits({
          currentMaxToolCalls: effectiveMaxToolCalls,
          currentTurnTimeoutMs: effectiveTurnTimeoutMs,
          orderBudget: approvedOrder.budget
        });
        effectiveTurnTimeoutMs = expandedLimits.turnTimeoutMs;
        effectiveMaxToolCalls = expandedLimits.maxToolCalls;
        const budget = taskOrderBudgetDecision({
          order: approvedOrder,
          nowMs: Date.now(),
          toolCalls: taskOrderToolCalls,
          recordsTouched: taskOrderRecordsTouched
        });
        if (!budget.ok) {
          await failTaskOrder(service, user, approvedOrder.id, budget.reason);
          const message = `Stopped task order: ${budget.reason}.`;
          await supabase.from("agent_messages").insert({
            session_id: sessionId,
            role: "assistant",
            content: message
          });
          await emit({ type: "assistant_delta", text: message });
          await emit({ type: "done" });
          return;
        }
      }
    }
    const teachMode = service ? await currentTeachMode(service, user, sessionId) : false;
    const turnInstructions = instructionsForTurn(teachMode, user.approvals_enabled, automaticGuideContext);
    const model = await provider.runTools({
      instructions: taskPreparationRecoveryBlocked
        ? `${turnInstructions}\n\nThe deterministic email worker ended with TASK_PREPARATION_FAILED. This is a hard stop for the current request. Do not retry scheduling or call Zoho read, browser, or UI recovery tools. Complete the active task order from the deterministic result and report the failure concisely.`
        : turnInstructions,
      messages: transcript,
      tools: AGENT_TOOL_DEFINITIONS.filter((tool) =>
        allowsToolAfterTaskPreparationFailure(tool.name, taskPreparationRecoveryBlocked)
      )
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
      if (toolCallCount >= effectiveMaxToolCalls) {
        const message = `Stopped after reaching the ${effectiveMaxToolCalls} tool-call budget.`;
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
        } else if (isTaskOrderTool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for task orders.");
          if (call.name === "propose_task_order") {
            const proposed = await proposeTaskOrder({ service, user, sessionId, call, userRequest: content, emit });
            ok = proposed.ok;
            result = proposed.result;
            pausedMs += proposed.pausedMs;
            const orderId = (proposed.result as { task_order_id?: unknown } | null)?.task_order_id;
            if (proposed.ok && typeof orderId === "string") {
              activeTaskOrderId = orderId;
              taskOrderToolCalls = 0;
              taskOrderRecordsTouched = 0;
            }
          } else {
            const completed = await completeTaskOrder({ service, user, sessionId, call });
            ok = completed.ok;
            result = completed.result;
            activeTaskOrderId = null;
          }
        } else if (isEmailSchedulingTool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for deterministic email scheduling.");
          const scheduled = await runEmailSchedulingBatch({
            service,
            user,
            sessionId,
            call,
            order: approvedOrder,
            emit
          });
          ok = scheduled.ok;
          result = scheduled.result;
          pausedMs += scheduled.pausedMs;
          if (!scheduled.ok && hasTaskPreparationFailure(scheduled.result)) {
            taskPreparationRecoveryBlocked = true;
            await service.from("audit_events").insert({
              user_id: user.id,
              event_type: "deterministic_task_recovery_blocked",
              message: "Blocked model-driven recovery after deterministic task preparation failure.",
              metadata: { session_id: sessionId, task_order_id: activeTaskOrderId, call_id: call.id }
            });
          }
        } else if (isBrowserTool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for browser tools.");
          if (call.name === "browser_observe") {
            const validatedCall = validateBrowserToolCall(call);
            result = await runBridgedTool({
              service,
              user,
              sessionId,
              call: validatedCall,
              onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
            });
          } else {
            const evalResult = await runBrowserEvalTool({ service, user, sessionId, call, order: approvedOrder, emit });
            ok = evalResult.ok;
            result = evalResult.result;
            pausedMs += evalResult.pausedMs;
          }
        } else if (isSkillGuideTool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for skill guides.");
          if (call.name === "list_skill_guides") {
            result = await listSkillGuides(service);
          } else if (call.name === "read_skill_guide") {
            result = await readSkillGuide(service, call);
          } else {
            const saved = await saveSkillGuide({ service, user, sessionId, call, emit });
            ok = saved.ok;
            result = saved.result;
            pausedMs += saved.pausedMs;
          }
        } else if (isUndoTool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for undo.");
          const undone =
            call.name === "undo_task"
              ? await undoTask({ supabase, service, user, sessionId, call, emit })
              : await undoRecord({ supabase, service, user, sessionId, call, emit });
          ok = undone.ok;
          result = undone.result;
          pausedMs += undone.pausedMs;
        } else if (isUiTool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for UI steps.");
          if (call.name === "list_ui_workflows") {
            result = await listUiWorkflows(service);
          } else if (call.name === "save_ui_workflow") {
            const saved = await saveUiWorkflow({ service, user, sessionId, call, emit });
            ok = saved.ok;
            result = saved.result;
            pausedMs += saved.pausedMs;
          } else if (call.name === "run_ui_workflow") {
            const replayed = await runUiWorkflowTool({ service, user, sessionId, call, emit });
            ok = replayed.ok;
            result = replayed.result;
            pausedMs += replayed.pausedMs;
          } else {
            if (approvedOrder) {
              const stepped = await runUiStepUnderTaskOrder({ service, user, sessionId, call, order: approvedOrder, emit });
              ok = stepped.ok;
              result = stepped.result;
              pausedMs += stepped.pausedMs;
            } else {
              const validatedCall = validateUiToolCall(call);
              result = await runBridgedTool({
                service,
                user,
                sessionId,
                call: validatedCall,
                onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
              });
            }
          }
        } else if (isTier2Tool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for approvals.");
          const gated = approvedOrder
            ? await runTier2UnderTaskOrder({ supabase, service, user, sessionId, call, order: approvedOrder, emit })
            : await handleTier2Call({ supabase, service, user, sessionId, call, emit });
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
        metadata: { session_id: sessionId, call_id: call.id, tool_name: call.name, ok, task_order_id: activeTaskOrderId }
      });
      if (activeTaskOrderId && !isTaskOrderTool(call.name)) {
        taskOrderToolCalls += 1;
        taskOrderRecordsTouched += taskOrderRecordUsage(call.name, call.args);
      }
      transcript.push({
        role: "tool",
        toolName: call.name,
        content: stringifyForModel(truncated),
        callId: call.id
      });
      await emit({ type: "tool_result", call_id: call.id, tool_name: call.name, result: truncated, ok });
    }
  }

  const message = `Stopped after reaching the ${Math.round(effectiveTurnTimeoutMs / 1000)} second turn budget.`;
  await supabase.from("agent_messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: message
  });
  await emit({ type: "assistant_delta", text: message });
  await emit({ type: "done" });
}
