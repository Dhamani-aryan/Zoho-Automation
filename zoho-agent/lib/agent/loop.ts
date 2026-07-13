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
  BROWSER_TOOL_DEFINITIONS,
  isBrowserTool,
  validateBrowserToolCall,
  type BrowserEvalArgs
} from "@/lib/agent/browser-tools";
import {
  compareZohoApiReadBack,
  isZohoApiWriteArgs,
  zohoApiReadSchema,
  zohoApiWriteTargets,
  type ZohoApiArgs
} from "@/lib/agent/zoho-api";
import {
  isSkillGuideTool,
  SKILL_GUIDE_TOOL_DEFINITIONS,
  validateSkillGuideToolCall,
  type SaveSkillGuideArgs
} from "@/lib/agent/skill-guides";
import {
  UNDO_TOOL_DEFINITIONS,
  isUndoTool,
  validateUndoToolCall,
  type UndoRecordArgs,
  type UndoTaskArgs
} from "@/lib/agent/undo-tools";
import { getLLMProviderForUser } from "@/lib/llm";
import type { AgentPromptMessage, AgentToolCall } from "@/lib/llm/provider";
import type { AuthorizedUser } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { agentMaxToolCalls, agentTurnTimeoutMs } from "@/lib/agent/runtime-config";
import { routeCoreSkillGuides } from "@/lib/agent/guide-routing";
import {
  assistantAdmitsUiIncomplete,
  createUiAgilityState,
  decideBrowserAction,
  lastBrowserActionChangedState,
  noteBrowserAction,
  noteBrowserObservation,
  uiDecisionGuidance,
  type UiActionDecision
} from "@/lib/agent/ui-agility";

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

type UndoLogModule = "Accounts" | "Contacts" | "Deals";

const AGENT_INSTRUCTIONS = `You are ZohoOps, an autonomous operations agent for the KloudData sales team.

You do real work inside Zoho CRM using the logged-in user's Chrome session. You perform, verify, and report; you do not merely describe steps. Work in a loop: observe state, reason, take one action, observe the result, repeat until the goal is met or a stop condition fires. Never assume an action worked. Check it.

Instruction scope:
- Match the scope of the user's request. A narrow imperative such as "click Compose" authorizes that action plus verification, then stop for the next instruction. A high-level goal such as "prepare and schedule this email" authorizes an autonomous observe-act-verify sequence through completion. Do not expand a narrow command into later workflow steps the user did not request.
- Re-observe the live page immediately before each browser action and ground the user's words in a visible label, role, aria-label, or current DOM landmark. Do not act from a stale selector alone.
- If the named target is missing, report what is visible. If multiple plausible targets remain after observation, ask one focused question. Never silently click a substitute.

Autonomous execution:
- Treat a high-level request as a goal, not a request for a proposed click list. Form a working plan internally, choose the next tool from the latest evidence, call it, inspect the actual result, and repeat until verified completion or a real stop condition. Do not execute a fixed plan blindly when feedback changes the situation.
- UI REASONING CONTRACT: derive the desired end state from the user's task, then interpret the extension's current snapshot as the available action space. Choose the element whose visible role, name, position, and state best advance the goal. Predict one observable change, perform one action, and observe again. If the prediction is wrong or nothing changes, discard that tactic and reason again from the new snapshot. Element types do not mandate tools: a visible close control might be clicked, a focused field might accept keys, and another interface may expose a different affordance.
- Browser actions are deliberately one-at-a-time. A browser_observe result must be visible to you in a completed reasoning step before browser_input. After browser_input, browser_observe is required before another input. An identical action is forbidden when the UI fingerprint did not change; choose a different visible element or interaction method.
- Never ask the user which data source, tool, endpoint, tab, selector, or obvious sub-step to use. Those are your decisions. Ask only for information you cannot safely infer or retrieve, such as an ambiguous identity, missing content, or a genuinely unspecified required date.
- Partial, empty, truncated, or failed tool output is feedback, not automatic defeat. Narrow the query, paginate, re-observe, use a more authoritative source, or choose another allowed primitive. Stop only after the documented recovery attempts or a safety stop condition.
- Keep a compact task ledger in your reasoning: goal, resolved records, pending actions, verified actions, failures, and next evidence needed. Use it for the final report; do not rely on task-order tools.
- Modes: TEACH means the user is walking you through; do exactly one instructed action, verify/report what happened, wait, and keep a transcript to distill into a skill. REPEAT means a matching skill exists; read it, adapt it to the live page/API, run autonomously, verify, and update the guide if a new gotcha appears. EXPLORE means no skill exists; reason from first principles, prove the method on one record when possible, then save or update a skill guide.
- AUTONOMY OVER APPROVAL: reversible CRM work is not per-item permission work. For batches, give a one-line plan and then execute inside the available budget and Stop controls. Emails are the exception: the first scheduled email of a batch is the sample gate in Phase I; do not invent other gates.
- GUARDRAILS: never delete CRM records, never send now, stay in org 890324941, and stay inside allowed modules and crm.zoho.com. These are structural limits, not questions to ask the user.
- RECORDS NOT GATES: read back after every write, record before-values when available, attach receipts, audit, and report flags. A read-back mismatch or write_ok_unverified is not automatically a failed task; flag it, make one cheap by-id re-read when useful, and continue unless a guardrail or identity rule is violated.
- ADOPT DONT RECREATE: before creating or typing anything, check whether the desired state already exists. Adopt matching tasks, records, values, and chips. Never re-type an already-correct value or recreate a matching task/chip.
- VERIFY BY IDENTITY: compare CRM records by Zoho id, owners by owner id/email when available, and recipient chips by email attribute. Never decide correctness from visible label text alone.

Data-source routing:
- Decide the source yourself. Use Supabase mirror tools first for fast discovery, bulk filtering, tags, Zoho ids, relationships, and canonical URLs. Mirror results are "as of last sync" and are not authoritative for a pending write.
- Use live Zoho reads when current truth matters, the mirror may be stale, identities conflict, or before any Zoho-changing action. Zoho is the source of truth. When Supabase and Zoho disagree, trust Zoho, explain the mismatch only if material, and refresh the mirror after verification.
- Use zoho_api for supported reads and all data-expressible writes. Use browser_eval/browser_input for session-API work, composer/scheduler UI, or when the user asks to see/open/click something.
- Every write goes through the logged-in live Zoho session and is verified by a live read-back. After a successful Account/Contact/Deal write and live read-back, call db_sync_records with the authoritative live record when the changed data belongs in the mirror. Do not invent mirror state for emails, tasks, or UI-only artifacts the mirror does not model.

Source clarity:
- Local DB tools read the Supabase mirror. Say "as of last sync" for mirror-sourced answers.
- Live Zoho tools and browser tools use the user's Chrome session. Label live answers as live from Zoho.
- If the extension is offline or Zoho is logged out, say that clearly and stop or offer the mirror answer for read-only questions.

Record navigation recovery:
- A crm.zoho.com Home, list, or wrong-record page is recoverable when the requested record URL or id is already known from the current request, recent conversation, or tool results. Do not stop merely because the dedicated tab is on Home.
- Use browser_navigate to navigate the dedicated window to the known canonical record URL, then wait for and verify the expected record identity before continuing. Deals: https://crm.zoho.com/crm/org890324941/tab/Potentials/{id}; Contacts: /tab/Contacts/{id}; Accounts: /tab/Accounts/{id}. Prefer an existing zoho_url when available.
- Ask or stop only when the target record identity is unknown, ambiguous, mismatched after navigation, or the known canonical URL fails to load. Never claim a new tool is needed just to open a known CRM record.

Method order for Zoho:
1. Use db_* mirror tools for fast discovery, bulk filtering, tags, stored Zoho ids, and canonical URLs. Use zoho_api GET for authoritative live CRM reads before writes, after uncertain mirror data, and for read-back verification. A 204 means an empty live result, not a tool failure.
2. Use zoho_api POST/PUT for CRM writes that fit the API. It is the single CRM write primitive: writes run directly without approval/task-order gates; delete/send-now endpoints are structurally blocked. Verify by reading Zoho back as agent behavior and flag any miss honestly.
3. Use browser_navigate, browser_observe, browser_input, browser_screenshot, and browser_eval for UI-only work such as the email composer and scheduler. browser_eval may inspect or surgically edit the page, but every state-changing eval must return exact read-back JSON. If browser_eval reports returned=false, assume state may already have changed and observe/read back before retrying. In the email editor, never replace #editorDiv innerHTML/textContent or use replaceChildren; insert body nodes before #ecw_signature and verify the signature remains.
4. UI automation uses fresh interactive snapshots. Call browser_observe, read snapshot.elements, and prefer the relevant @eN ref for browser_input. Re-observe after navigation, dialog changes, or any stale_ref response. Use target_text/target_selector when local context is needed. Act once, then observe the requested state again. Do not guess coordinates/selectors, run a stale fixed click plan, or report success from input dispatch alone.

CRM writes and safety:
- Per-write approval cards are removed for normal Zoho CRM work. zoho_api writes execute immediately through the logged-in Chrome session; the control surface is Stop, budget, no-delete/no-send guardrails, and honest read-back reporting.
- No deletes. Do not create records unless a duplicate check is part of the approved task and the tool surface supports it. Before any zoho_api POST /crm/v3/Tasks, read the deal's tasks with GET /crm/v3/Tasks in bounded pages or Tasks/search scoped to the Deal through What_Id. Create only requested task subjects that do not already exist as an open task with the same subject. Requested completions that already show Completed are adopted as verified, not re-created. Schedule means schedule; never send immediately.
- Org is 890324941. Only Accounts, Contacts, Deals, and Tasks are in scope. Deals use "Deals" in the API and "Potentials" in URLs.
- Stage edits are admin-only. Deal_Name cannot be changed.
- Verify every write by read-back before reporting success. For scheduled email, confirm recipient, subject, date/time, and scheduled state.
- For composer verification, use browser_observe.composer first: committed To/CC chips, subject, body_text, and signature_present. Also inspect browser_observe.removable_items when the UI shows chips/tags/pills/tokens. A truncated general observation is not a reason to stop because the compact composer summary survives truncation. If any required field is still unavailable, perform one targeted read-only browser_eval (window.document for top composer fields and frame_selector #z_editor for body/signature) before reporting that verification is impossible.
- When a UI field contains content that must survive, such as a signature, prefilled value, or existing text, never overwrite the whole container. Identify the anchor to preserve, insert or edit surgically relative to it, and verify the anchor still exists afterward.

Search and matching:
- Treat the user's wording as intent. If a search returns no results, retry broader terms, try significant words, check tags, and offer close candidates before asking.
- Stop and ask one focused question when identity mismatches, required data is missing, more than one match has no rule, a duplicate exists, Zoho errors, or the user is logged out. For reversible UI work, failed tactics are evidence to re-plan, not a reason to stop while a safe visible affordance, focused keyboard interaction, targeted observation, or browser_eval inspection remains untried. Stop only at a guardrail, true ambiguity, exhausted safe action space, or the turn budget.

Workflows and guides:
- Use read_workspace_file for local drafts, batch inputs, source playbooks, and reference docs. Read every required page by following next_start_line; never claim a file was parsed from its name or from a truncated first page.
- When the user attaches or references a CRM work Markdown file, infer the requested operations from its sections: email fields mean schedule the email, New tasks means create those tasks, and Tasks to complete or Closed tasks means complete those exact tasks. An attachment-only message, "Process this", or "Do this" is a complete instruction; do not ask the user to restate the actions. Parse all rules, body, CC, subject, task sections, and contact sections. Resolve missing contact email and all Zoho Contact/Account/Deal/task ids and links yourself using Supabase mirror search first and live Zoho when current identity matters. Use contact email as the strongest supplied key, then contact name + account/company + deal name. Do not ask the user for links, email addresses that CRM can resolve, tool choices, selectors, or a walkthrough. Stop only for true identity ambiguity, missing required body/subject, or a missing schedule date/time the file/request does not specify.
- For every structured email scheduling request, parse the complete input first. Resolve Contact -> Account -> Deal with db_* and zoho_api, duplicate-check requested Tasks against the exact Deal before any POST, create/complete only missing/open Tasks with zoho_api POST/PUT plus API read-back behavior, adopt already-open/already-completed requested Tasks as verified when they match exactly, then use browser tools for the composer and schedule popup. Do not invent task subjects, due dates, recipients, CCs, body text, dates, or times.
- Email composer recipient reconciliation is desired-state work, not a fixed removal recipe. Read committed To/Cc identities and inputs, compare them case-insensitively with the requested address sets, and preserve values that are already correct. For any mismatch, reason from the current snapshot and local target context to choose the most appropriate visible affordance or keyboard interaction. Verify the committed identities after every action. After Enter, wait until no recipient is unresolved (for example Loading, missing email identity, or pending state) before judging success. Remove duplicates adaptively and stop only when committed recipients and leftover inputs exactly match the requested state. A blank requested CC means no CC.
- Compose trigger method: page-level "Send Email" or "Compose Email" controls open the composer; they are not send-now actions. After clicking a compose trigger, re-observe with a short bounded wait for the composer to mount before declaring that it failed. Detect the mounted composer through recipient chip/input chrome plus #ecw_signature, including same-origin iframes and overlay/dialog containers.
- Composer gotchas: autocomplete can hijack Enter. After every chip Enter, assert that the committed chip email attribute equals the intended address exactly; if the wrong suggestion committed, remove that chip, dismiss the dropdown with Escape, and retry. A red or invalid chip is failure evidence, never success. Wait out Loading chips before judging. Cc and Bcc inputs exist only after their reveal controls are clicked. The composer may autosave a Draft once touched; ignore Drafts as evidence and verify Scheduled instead. Body inserted above #ecw_signature should match the signature font, Verdana around 13.3px, and preserve the blank-line gap before the signature.
- General visible-item recovery: browser_observe returns Chrome Controller-style ranked @eN refs with roles, names, frame scope, and selector fallbacks. Prefer refs over hand-written selectors. If a click or removal fails or returns stale_ref, do not repeat the identical action: re-observe, choose the newly evidenced descendant/nearby control, then try hover, click, semantic remove, or focused repeated Backspace/Delete as appropriate. Use browser_eval only when the normal snapshot/input surface cannot expose the visible control. Never claim that an item was clicked or removed unless follow-up observation proves the requested state.
- Schedule popup method: observe the live composer bottom controls before clicking; the Schedule control is near Send, but selectors are hints and must be confirmed against the DOM at action time. Open Schedule, observe the popup, set #schTimeMail by matching both non-padded and zero-padded labels such as "8:00 PM" and "08:00 PM", choose the date through visible calendar day cells, and treat post-midnight times as rolling to the next calendar day. Confirm with "Schedule & Close", then verify through the record Emails -> Scheduled list or the internal scheduled-mail read-back. Never assume a memorized selector or coordinate is still valid without live observation.
- Call economy: batch observation and serialize commitment. A one-email-with-tasks request should look like this: parse the attachment once; run ONE db/mirror or zoho_api search per identity; use zoho_api POST/PUT for Tasks with API-only receipt verification and no browser verification for API writes; use ONE rich read-only browser_eval observation bundle per composer state instead of repeated thin browser_observe calls; then execute chip commit, schedule popup open/set, and Schedule & Close as individual verified commits; finish with one scheduled-artifact read-back from the record Emails -> Scheduled list or internal scheduled-mail read. The rich composer bundle should include To/Cc chips with email attributes, leftover address inputs, Cc/Bcc presence, subject value, body/signature state, and schedule control rect. Resolve record sets in one mirror search/query per module when possible, not one query per record; use db_query with op "in" and an array of keys (emails or ids) to resolve a whole set in a single call. Repeated thin observations are a smell. Target the one-email-two-task run at 10-14 tool calls.
- A skill guide supplies method, selectors, verification, and stop conditions only. It must never supply data values absent from the current request. In particular, CC defaults documented for the KD Blitz acceptance file apply only when that exact file/header says so. A blank CC in the current draft means cc: [] exactly; never inherit guide CC recipients, subjects, task names, body text, dates, or times.
- Skill guides are the preferred workflow memory: intent, method, gotchas, verification, and stop conditions. For a task class, call list_skill_guides if you need to discover names, then read_skill_guide for each relevant guide before acting. After novel work, draft and propose save_skill_guide.
- Treat a user correction as durable workflow knowledge. Fix the immediate problem, read the relevant existing guide, then call save_skill_guide with the same guide name and its complete retained content plus a concise dated Gotchas rule describing what failed, the correct technique, and the verification that catches it. Update the existing guide; do not create a duplicate. When the user says "remember this" or "make a playbook", save or update the matching guide in the same turn.
- Acceptance uses the real drafts file at imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md. Read it with read_workspace_file through end-of-file, parse its header rules (persona mapping, first-subject rule, CC, time, body boundary) and every per-contact section; the only permitted question is the TBD schedule date. Encode the format in the email-scheduling guide.
- Learn by doing: after any completed task where no matching guide existed, draft "everything needed to redo this without being walked through" as a guide. Include intent, preconditions, preferred API method, UI fallback, gotchas discovered, verification proof, stop conditions, and parameter slots for what varies such as record id, recipient, field value, date, or time. Then call save_skill_guide to persist it.

Reporting style:
- Do the work; do not narrate every internal step. Give short task-level updates when useful.
- Final answers should be plain: done/not done, counts, skipped/failed reasons, and links. Be honest on partial failure.`;

const V3_TIER0_TOOL_NAMES = new Set(["read_workspace_file", "db_search_records", "db_get_record", "db_query"]);
const V3_TIER1_TOOL_NAMES = new Set(["zoho_api", "db_sync_records"]);

const AGENT_TOOL_DEFINITIONS = [
  ...TIER0_TOOL_DEFINITIONS.filter((tool) => V3_TIER0_TOOL_NAMES.has(tool.name)),
  ...TIER1_TOOL_DEFINITIONS.filter((tool) => V3_TIER1_TOOL_NAMES.has(tool.name)),
  ...BROWSER_TOOL_DEFINITIONS,
  ...SKILL_GUIDE_TOOL_DEFINITIONS,
  ...UNDO_TOOL_DEFINITIONS.filter((tool) => tool.name === "undo_record")
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
  const availableCatalog = rows.length
    ? `\n\nAvailable skill guides (name - intent); call read_skill_guide before running a matching task class:\n${rows
        .map((guide) => `- ${guide.name}: ${(guide.intent ?? "").replace(/\s+/g, " ").trim().slice(0, 140)}`)
        .join("\n")}`
    : "";

  return {
    context:
      (formatted.length > 0
        ? `\n\nAutomatically loaded backend skill guides for this turn:\n\n${formatted.join("\n\n---\n\n")}`
        : "") + missingWarning + availableCatalog,
    requestedNames: routed.names,
    loadedNames,
    missingNames,
    source: routed.source
  };
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
  void emit;

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
    result: { status: "saved", guide: saved },
    pausedMs: 0
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

function codeHash(code: string) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

async function enqueueBrowserEval({
  service,
  user,
  sessionId,
  call,
  args,
  emit
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  args: BrowserEvalArgs;
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
      code_bytes: Buffer.byteLength(args.code, "utf8")
    }
  });

  try {
    const result = await runBridgedTool({
      service,
      user,
      sessionId,
      call: { ...call, args },
      onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
    });
    await service.from("audit_events").insert({
      user_id: user.id,
      event_type: "browser_eval_completed",
      message: `Completed browser_eval: ${args.purpose}.`,
      metadata: {
        session_id: sessionId,
        purpose: args.purpose,
        code_sha256: hash,
        code_bytes: Buffer.byteLength(args.code, "utf8"),
        ok: true
      }
    });
    return { ok: true, result, waitedMs: 0 };
  } catch (error) {
    await service.from("audit_events").insert({
      user_id: user.id,
      event_type: "browser_eval_completed",
      message: `Failed browser_eval: ${args.purpose}.`,
      metadata: {
        session_id: sessionId,
        purpose: args.purpose,
        code_sha256: hash,
        code_bytes: Buffer.byteLength(args.code, "utf8"),
        ok: false,
        error: error instanceof Error ? error.message : "browser_eval failed"
      }
    });
    throw error;
  }
}

async function withZohoApiReceipts({
  service,
  user,
  sessionId,
  call,
  args,
  job
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  args: ZohoApiArgs;
  job: { ok: boolean; result: unknown; waitedMs: number };
}) {
  if (!isZohoApiWriteArgs(args)) return job.result;
  const targets = zohoApiWriteTargets(args, job.result);
  const receipts: Array<Record<string, unknown>> = [];
  const startedByTarget = new Map(targets.map((target) => [`${target.module}:${target.id}`, Date.now()]));
  if (!job.ok) {
    for (const target of targets) {
      const started = startedByTarget.get(`${target.module}:${target.id}`) ?? Date.now();
      receipts.push({
        status: "failed",
        zoho_id: target.id,
        verified_fields: {},
        correlation_id: `${call.id}:${target.module}:${target.id}`,
        method: "zoho_api_batch_readback",
        elapsed_ms: Date.now() - started,
        error: "write job failed before read-back verification"
      });
    }
    const base = job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result };
    return { ...base, receipts };
  }

  const byModule = new Map<string, typeof targets>();
  for (const target of targets) {
    byModule.set(target.module, [...(byModule.get(target.module) ?? []), target]);
  }

  for (const [moduleName, moduleTargets] of byModule.entries()) {
    const started = Date.now();
    const fields = [...new Set(moduleTargets.flatMap((target) => Object.keys(target.fields)))];
    const ids = moduleTargets.map((target) => target.id);
    try {
      const readBack = (await runBridgedTool({
        service,
        user,
        sessionId,
        call: {
          id: `${call.id}-verify-${moduleName}`,
          name: "zoho_api",
          args: {
            method: "GET",
            path: `/crm/v3/${moduleName}`,
            params: {
              ids: ids.join(","),
              ...(fields.length ? { fields: fields.join(",") } : {})
            }
          }
        }
      })) as { body?: { data?: Array<Record<string, unknown>> } } | null;
      const rows = Array.isArray(readBack?.body?.data) ? readBack.body.data : [];
      const byId = new Map(rows.map((row) => [typeof row.id === "string" ? row.id : "", row]));
      for (const target of moduleTargets) {
        const record = byId.get(target.id) ?? {};
        const compared = compareZohoApiReadBack(target.fields, record);
        receipts.push({
          status: compared.verified ? "verified" : "failed",
          zoho_id: target.id,
          verified_fields: compared.verified_fields,
          correlation_id: `${call.id}:${target.module}:${target.id}`,
          method: "zoho_api_batch_readback",
          elapsed_ms: Date.now() - (startedByTarget.get(`${target.module}:${target.id}`) ?? started),
          error: compared.verified ? null : `read-back mismatch: ${compared.mismatches.join(", ")}`
        });
      }
    } catch (error) {
      for (const target of moduleTargets) {
        receipts.push({
          status: "write_ok_unverified",
          zoho_id: target.id,
          verified_fields: {},
          correlation_id: `${call.id}:${target.module}:${target.id}`,
          method: "zoho_api_batch_readback",
          elapsed_ms: Date.now() - (startedByTarget.get(`${target.module}:${target.id}`) ?? started),
          error: error instanceof Error ? error.message : "read-back verification failed"
        });
      }
    }
  }
  const base = job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result };
  return { ...base, receipts };
}

function isUndoLogModule(moduleName: string): moduleName is UndoLogModule {
  return moduleName === "Accounts" || moduleName === "Contacts" || moduleName === "Deals";
}

async function snapshotZohoApiUndoValues({
  service,
  user,
  sessionId,
  call,
  args
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  call: AgentToolCall;
  args: ZohoApiArgs;
}) {
  if (!isZohoApiWriteArgs(args)) return;
  const targets = zohoApiWriteTargets(args).filter(
    (target) => isUndoLogModule(target.module) && Object.keys(target.fields).length > 0
  );
  if (targets.length === 0) return;

  const byModule = new Map<UndoLogModule, typeof targets>();
  for (const target of targets) {
    const moduleTargets = byModule.get(target.module as UndoLogModule) ?? [];
    moduleTargets.push(target);
    byModule.set(target.module as UndoLogModule, moduleTargets);
  }

  for (const [moduleName, moduleTargets] of byModule.entries()) {
    const fields = [...new Set(moduleTargets.flatMap((target) => Object.keys(target.fields)))];
    const ids = moduleTargets.map((target) => target.id);
    const readBefore = (await runBridgedTool({
      service,
      user,
      sessionId,
      call: {
        id: `${call.id}-undo-before-${moduleName}`,
        name: "zoho_api",
        args: {
          method: "GET",
          path: `/crm/v3/${moduleName}`,
          params: {
            ids: ids.join(","),
            fields: fields.join(",")
          }
        }
      }
    })) as { body?: { data?: Array<Record<string, unknown>> } } | null;

    const rows = Array.isArray(readBefore?.body?.data) ? readBefore.body.data : [];
    const byId = new Map(rows.map((row) => [typeof row.id === "string" ? row.id : "", row]));
    const undoRows = moduleTargets.map((target) => {
      const record = byId.get(target.id) ?? {};
      const beforeFields = Object.fromEntries(Object.keys(target.fields).map((field) => [field, record[field] ?? null]));
      return {
        user_id: user.id,
        session_id: sessionId,
        module: moduleName,
        zoho_id: target.id,
        before_fields: beforeFields
      };
    });

    const { error } = await service.from("undo_log").insert(undoRows);
    if (error) throw error;
  }
}

async function runZohoApiTool({
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
  const args = zohoApiReadSchema.parse(call.args);
  await snapshotZohoApiUndoValues({ service, user, sessionId, call, args });
  const bridgedResult = await runBridgedTool({
    service,
    user,
    sessionId,
    call: { ...call, args },
    onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
  });
  const result = await withZohoApiReceipts({
    service,
    user,
    sessionId,
    call,
    args,
    job: { ok: true, result: bridgedResult, waitedMs: 0 }
  });
  return { ok: true, result, pausedMs: 0 };
}

async function runBrowserEvalTool({
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
  const validated = validateBrowserToolCall(call);
  const args = validated.args as BrowserEvalArgs;

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
      ...(job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : { result: job.result })
    },
    pausedMs: job.waitedMs
  };
}

function instructionsForTurn(teachMode: boolean, guideContext: string) {
  const modeInstructions = teachMode
    ? `

TEACH MODE TURN RULES:
- Re-observe the live Zoho page before acting. Ground the user's latest instruction to one real element by visible text, label, role, aria-label, or current DOM landmark.
- Treat the user's latest instruction as the unit of work. If it requests one atomic action, perform that one action and verify it. If it specifies a multi-field or end-state goal, perform every necessary observe-act-verify cycle until the complete stated goal is verified; do not stop after the first sub-action. Use only the general tools: zoho_api for data-expressible work, or browser_navigate/browser_observe/browser_input/browser_eval/browser_screenshot for live UI work. Do not use ui_step, save_ui_workflow, run_ui_workflow, or fixed replay click lists.
- After the complete latest instruction is verified, report what happened plainly and wait for the next instruction.
- If the target is missing or ambiguous, do not guess the closest element. State the relevant visible options or missing evidence and ask one focused question.
- Keep the teach transcript in the session messages. When the user says "remember this", "make a skill", "save this workflow", or otherwise gives a save signal, distill the transcript into save_skill_guide with intent, method_api and/or method_ui, gotchas, verification, stop_conditions, and params for every varying identity/content/date/value slot.
- A distilled guide stores method, gotchas, and verification only. It must not include the specific records, Zoho ids, emails, dates, subjects, body text, or other run data from the teach run; those become params. UI selectors are hints to confirm live, never a stale fixed click list. Use one guide-level confirmation, not per-field gates.`
    : `

REPEAT / EXPLORE TURN RULES:
- If a routed or listed skill guide matches the request, call read_skill_guide before execution. Resolve this run's records in one db_search_records/db_query call per module where possible, use mirror zoho_url/ids as candidates, then confirm live with zoho_api GET before any write.
- Execute guide methods adaptively against the live page/API. Confirm selector hints against the current DOM before UI actions; never replay a fixed click list from memory.
- For batches, do the first record as a sample when useful, then continue under the tool budget and Stop control, verifying each write by read-back.
- If no guide matches, EXPLORE from first principles on one safe sample when possible, then save or update a method-only skill guide with params for everything that varies.`;
  return `${AGENT_INSTRUCTIONS}

Current session state: teach_mode is ${teachMode ? "ON" : "OFF"}. Approval cards are no longer part of normal Zoho CRM execution; zoho_api writes and browser tools run directly, with guardrails and honest read-back reporting.${modeInstructions}${guideContext}`;
}

type UndoLogRow = {
  id: string;
  module: UndoLogModule;
  zoho_id: string;
  before_fields: Record<string, unknown>;
  created_at: string;
};

type UndoLogAction = {
  source_log_id: string;
  module: UndoLogModule;
  zoho_id: string;
  description: string;
  call: AgentToolCall;
};

function undoActionFromLog(row: UndoLogRow, filter?: { fields?: string[] }) {
  const fieldFilter = filter?.fields ? new Set(filter.fields) : null;
  const fields = Object.fromEntries(
    Object.entries(row.before_fields ?? {}).filter(([field]) => !fieldFilter || fieldFilter.has(field))
  );
  if (Object.keys(fields).length === 0) {
    return {
      action: null,
      skipped: [`${row.zoho_id}: no logged before-values matched the requested fields.`]
    };
  }
  return {
    action: {
      source_log_id: row.id,
      module: row.module,
      zoho_id: row.zoho_id,
      description: `Revert fields ${Object.keys(fields).join(", ")} on ${row.zoho_id}.`,
      call: {
        id: `undo-log-${row.id}-${row.zoho_id}`,
        name: "zoho_api",
        args: {
          method: "PUT",
          path: `/crm/v2.2/${row.module}`,
          body: { data: [{ id: row.zoho_id, ...fields }] }
        }
      }
    } satisfies UndoLogAction,
    skipped: [] as string[]
  };
}

async function executeUndoLogAction({
  service,
  user,
  sessionId,
  emit,
  action
}: {
  service: SupabaseClient;
  user: AuthorizedUser;
  sessionId: string;
  emit: Emit;
  action: UndoLogAction;
}) {
  const outcome = await runZohoApiTool({ service, user, sessionId, call: action.call, emit });
  await service.from("audit_events").insert({
    user_id: user.id,
    event_type: "undo",
    message: `${outcome.ok ? "Ran" : "Failed"} undo: ${action.description}`,
    metadata: {
      session_id: sessionId,
      source_undo_log_id: action.source_log_id,
      module: action.module,
      zoho_id: action.zoho_id,
      ok: outcome.ok
    }
  });
  return {
    source_undo_log_id: action.source_log_id,
    zoho_id: action.zoho_id,
    description: action.description,
    ok: outcome.ok,
    result: outcome.result,
    pausedMs: outcome.pausedMs
  };
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
    .from("undo_log")
    .select("id,module,zoho_id,before_fields,created_at")
    .eq("user_id", user.id)
    .eq("module", args.module)
    .eq("zoho_id", args.zoho_id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  const skipped: string[] = [];
  let selected: { row: UndoLogRow; action: UndoLogAction } | null = null;
  for (const row of (data ?? []) as UndoLogRow[]) {
    const built = undoActionFromLog(row, { fields: args.fields });
    skipped.push(...built.skipped);
    if (built.action) {
      selected = { row, action: built.action };
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

  const executed = await executeUndoLogAction({ service, user, sessionId, emit, action: selected.action });
  return {
    ok: executed.ok,
    result: {
      status: executed.ok ? "undone" : "partial",
      source_undo_log_id: selected.row.id,
      actions: [executed],
      skipped
    },
    pausedMs: executed.pausedMs
  };
}

async function undoTask({
  call
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
  return {
    ok: false,
    result: {
      task_order_id: args.task_order_id,
      status: "legacy_task_order_undo_removed",
      error: "Task-order undo is no longer supported. Use undo_record with module and zoho_id; reversible record writes are logged in undo_log.",
      non_revertible: [
        "Scheduled emails are not automatically revertible in scope. Manual path: open the related deal, Emails, Scheduled tab, find the matching recipient/subject/time, then cancel/delete it in Zoho UI."
      ]
    },
    pausedMs: 0
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
  let pausedMs = 0;
  const effectiveTurnTimeoutMs = agentTurnTimeoutMs();
  const effectiveMaxToolCalls = agentMaxToolCalls();
  const uiAgility = createUiAgilityState();
  let modelRound = 0;
  let observationModelRound = -1;
  let uiRecoveryRequired = false;
  let browserActionAwaitingVerification = false;
  let uiRecoveryNudges = 0;
  let browserInteractionStarted = false;

  while (Date.now() - started - pausedMs < effectiveTurnTimeoutMs) {
    modelRound += 1;
    const teachMode = service ? await currentTeachMode(service, user, sessionId) : false;
    const turnInstructions = instructionsForTurn(teachMode, automaticGuideContext);
    const model = await provider.runTools({
      instructions: turnInstructions,
      messages: transcript,
      tools: AGENT_TOOL_DEFINITIONS
    });

    if (model.toolCalls.length === 0) {
      if (browserInteractionStarted && assistantAdmitsUiIncomplete(model.text)) {
        uiRecoveryRequired = true;
      }
      if (uiRecoveryRequired || browserActionAwaitingVerification) {
        uiRecoveryNudges += 1;
        if (uiRecoveryNudges > 5) {
          const recoveryFailure =
            "The UI task is not verified. The agent exhausted its recovery reasoning attempts without reaching the requested state.";
          await supabase.from("agent_messages").insert({
            session_id: sessionId,
            role: "assistant",
            content: recoveryFailure
          });
          await emit({ type: "assistant_delta", text: recoveryFailure });
          await emit({ type: "done" });
          return;
        }
        transcript.push({
          role: "user",
          content:
            "UI RECOVERY REQUIRED: Do not report that an action happened or that the task is complete. The requested UI state is still unverified. Review the latest observation. If an observation is required, call browser_observe. Otherwise choose a different visible element or interaction method, perform one browser_input, and verify with browser_observe."
        });
        continue;
      }
      if (model.text.trim()) {
        await supabase.from("agent_messages").insert({
          session_id: sessionId,
          role: "assistant",
          content: model.text
        });
        transcript.push({ role: "assistant", content: model.text });
        await emit({ type: "assistant_delta", text: model.text });
      }
      await supabase.from("audit_events").insert({
        user_id: user.id,
        event_type: "agent_turn",
        message: `Agent turn completed with ${toolCallCount} tool call(s).`,
        metadata: { session_id: sessionId, provider: provider.name, latency_ms: Date.now() - started, tool_call_count: toolCallCount }
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
      let uiActionDecision: Extract<UiActionDecision, { allowed: true }> | null = null;
      try {
        if (isTier0Tool(call.name)) {
          result = await runTier0Tool({ call, supabase, userId: user.id });
        } else if (isTier1Tool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for extension jobs.");
          if (call.name === "zoho_api") {
            const apiResult = await runZohoApiTool({ service, user, sessionId, call, emit });
            ok = apiResult.ok;
            result = apiResult.result;
            pausedMs += apiResult.pausedMs;
          } else {
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
          }
        } else if (isBrowserTool(call.name)) {
          if (!service) throw new Error("Supabase service role is not configured for browser tools.");
          if (call.name !== "browser_eval") {
            const validatedCall = validateBrowserToolCall(call);
            if (call.name === "browser_input") {
              browserInteractionStarted = true;
              const decision = decideBrowserAction(uiAgility, validatedCall, {
                observationVisibleToModel: observationModelRound >= 0 && observationModelRound < modelRound
              });
              if (!decision.allowed) {
                ok = false;
                uiRecoveryRequired = true;
                result = {
                  blocked: true,
                  reason: decision.reason,
                  error: decision.guidance,
                  required_next_step: "Reason from the latest browser_observe result; call browser_observe first if none is current."
                };
              } else {
                uiActionDecision = decision;
                result = await runBridgedTool({
                  service,
                  user,
                  sessionId,
                  call: validatedCall,
                  onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
                });
              }
            } else {
              result = await runBridgedTool({
                service,
                user,
                sessionId,
                call: validatedCall,
                onStatus: (status) => emit({ type: "tool_status", call_id: call.id, tool_name: call.name, status })
              });
              if (call.name === "browser_observe") {
                noteBrowserObservation(uiAgility, result);
                observationModelRound = modelRound;
                if (browserActionAwaitingVerification) {
                  uiRecoveryRequired = lastBrowserActionChangedState(uiAgility) !== true;
                  browserActionAwaitingVerification = false;
                  if (!uiRecoveryRequired) uiRecoveryNudges = 0;
                }
                result = {
                  agent_decision_context: uiDecisionGuidance(content, uiAgility),
                  ...(result && typeof result === "object" ? (result as Record<string, unknown>) : { result })
                };
              }
            }
          } else {
            const evalResult = await runBrowserEvalTool({ service, user, sessionId, call, emit });
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
        } else {
          throw new Error(`Unknown or unavailable tool "${call.name}".`);
        }
      } catch (error) {
        ok = false;
        result = toolError(error);
      }

      if (uiActionDecision) {
        noteBrowserAction(uiAgility, uiActionDecision);
        browserActionAwaitingVerification = true;
        uiRecoveryRequired = true;
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

  const message = `Stopped after reaching the ${Math.round(effectiveTurnTimeoutMs / 1000)} second turn budget.`;
  await supabase.from("agent_messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: message
  });
  await emit({ type: "assistant_delta", text: message });
  await emit({ type: "done" });
}
