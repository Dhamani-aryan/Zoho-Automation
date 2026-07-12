# Zoho CRM Agent - Full Project Brief (no code attached; this document is the codebase explained)

You are being asked to review an agent system you have indirectly shaped. Your composer
method notes, system-prompt structure, and "agent-first, not workflow-first" writeup were
used as reference material. This brief describes the entire system - architecture, tools,
safety machinery, data model, history, and current failures - in enough detail that you can
critique the approach and recommend changes without seeing the source.

## 1. What this is

A local-only agent that does real work in Zoho CRM for the KloudData sales team through the
user's own logged-in Chrome session. Primary workload: the user attaches a Markdown work
request (contact/company/deal identity, email subject+body, schedule date/time, tasks to
create, tasks to complete) and says "Process this and verify everything." The agent must
resolve all CRM identities itself (Contact -> Account -> Deal, email address, record ids,
canonical URLs), create/complete Tasks, compose the email in Zoho's composer, SCHEDULE it
(never send immediately), and verify every result by reading it back from Zoho.

Hard constraints, non-negotiable:
- Runs only at http://localhost:3000 (Next.js App Router). No deployment/hosting.
- Cloud Supabase (Postgres + RLS) is the only backend state store.
- Schedule emails, never send immediately. No CRM deletes, ever.
- Preserve the user's existing Zoho email signature in every composed email.
- Every CRM write is verified through a live read-back.
- Org/module allowlist (org 890324941; modules Accounts, Contacts, Deals, Tasks).
- All CRM writes pass through approval or task-order gates; the Chrome extension refuses
  unlinked write jobs on its side too.

## 2. Components

1. **Next.js app (localhost:3000)** - chat UI ("/agent"), session list, streaming SSE
   responses, approval prompt UI, Stop button, admin activity page, records mirror UI,
   settings. Server routes run the agent loop and the extension job bridge.
2. **Cloud Supabase** - users/auth, agent_sessions, agent_messages (full transcript incl.
   tool calls/results), tool_jobs (extension job queue), pending_approvals, task_orders,
   audit_events (every consequential action), skill_guides (versioned playbooks), records
   mirror tables (accounts/contacts/deals synced from Zoho), ui_workflows (saved UI step
   recipes). RLS everywhere; service-role client only server-side.
3. **Chrome MV3 extension (unpacked, user's own Chrome)** - polls the backend every ~1.5s
   (plus a 1-minute alarm as MV3 service-worker keepalive) to claim one job at a time,
   executes it against crm.zoho.com, reports the result. Auth: bearer token handshake.
   All UI-driving jobs run in a dedicated background Chrome window that is never focused,
   activated, or resized; script injection and CDP target the stored tab id directly so
   the user's foreground work is never disturbed. API jobs may quietly reuse an existing
   CRM tab.
4. **LLM providers** - OpenAI Responses API function calling (API key) or a Codex
   subscription variant with the same runTools() interface. Item-based transcripts with
   paired function_call / function_call_output by call_id.

## 3. How a turn works

User message (optionally with attached files, which land in a confined workspace directory
readable via a read_workspace_file tool) -> server persists it -> loop composes instructions
(base "soul" prompt + auto-routed skill guides relevant to the request) -> model runs with
the tool list -> each tool call is validated (JSON schema by the provider, then Zod
server-side), executed, its result truncated to a char limit and appended to the transcript
-> repeat until the model answers or budgets end the turn. Every tool call and outcome is
audited. Tool results stream to the UI as typed SSE events.

Tool execution paths:
- In-process tools (mirror DB reads, workspace file reads) run directly on the server.
- Extension-bridged tools insert a tool_jobs row; the server polls for the report with a
  bounded wait; the extension claims, executes in the page, reports. Timeouts distinguish
  "never claimed" from "claimed but never reported".
- Zoho page execution uses chrome.scripting.executeScript world:"MAIN" so code runs in the
  real crm.zoho.com page context with the user's session. Zoho API calls read the hidden
  #token input and send X-ZCSRF-TOKEN: crmcsrfparam=<token>, X-CRM-ORG, X-Requested-With,
  credentials:"include" - your #token pattern, adopted wholesale.
- Trusted input (real clicks/keys) uses chrome.debugger CDP Input.dispatchMouseEvent /
  dispatchKeyEvent, with coordinates derived from element rects at action time.

## 4. Current model-facing tool surface (about 15 tools, one CRM write path)

Discovery / local data:
- db_search_records, db_get_record, db_list_by_tag, db_list_tags, db_query - read the
  Supabase mirror of Accounts/Contacts/Deals (exact -> starts_with -> contains -> token
  matching). Fast, no Chrome needed, labeled as-of-last-sync.
- db_sync_records - upsert live Zoho rows into the mirror (local DB write only).
- read_workspace_file - paged reads of attached/workspace files.
- request_new_tool - files a request row instead of improvising when nothing fits.

Live CRM:
- zoho_api - THE single CRM API primitive. GET is a free read. POST/PUT are gated writes
  (see safety). DELETE/PATCH do not exist. Paths are validated against anchored regex
  allowlists (module list above, /search, settings/fields, users) on BOTH the server and
  inside the extension runner; delete-like and send-now-like paths are blocklisted on both
  sides as well. 204 returns { status: 204, empty: true }. Params capped. POST/PUT require
  a JSON body; GET must not have one.

Browser (all in the dedicated background window, crm.zoho.com only):
- browser_navigate (URL host-restricted), browser_observe (scoped DOM/accessibility
  summaries), browser_screenshot (CDP JPEG capped 500 KB), browser_input (trusted CDP
  click / type / key on selector-or-visible-text targets), browser_eval (model-written JS
  in page MAIN world; must return JSON-serializable read-back; a frame_selector can bind
  document to a same-origin iframe such as the composer body).

Governance / memory:
- propose_task_order / complete_task_order (see safety), undo_record (reverts a mirrored
  field write using stored before-values), list_skill_guides / read_skill_guide /
  save_skill_guide (versioned playbooks in Supabase), list_ui_workflows / run_ui_workflow
  (legacy saved UI recipes), ui_step (single watched UI action, teach mode only).

Recently REMOVED from the model surface (the flip - see history): schedule_zoho_email_batch
(a deterministic one-shot email pipeline), zoho_search/zoho_get_record/zoho_get_related/
zoho_read_api (read wrappers superseded by zoho_api), zoho_update_fields/zoho_change_owner/
zoho_add_tags/zoho_remove_tags (business-verb writes superseded by gated zoho_api). Their
server code still exists pending a deletion pass.

## 5. Safety machinery (the part we will not give up)

- **Approvals**: users.approvals_enabled. Small direct writes create a pending_approvals
  row with an exact immutable args snapshot + human-readable summary; the user approves or
  rejects in chat UI; the approved snapshot is executed exactly as approved.
- **Task orders**: unattended/batch work (file-driven runs, >3 records) requires
  propose_task_order (scope read|write, description, record budget). The user approves it.
  Budgets are enforced server-side: per-order tool-call cap, wall-clock cap, and a record
  budget where only mutating calls count (reads count zero). A Stop button flips the order
  to stopped and the loop halts between calls.
- **Extension-side refusal**: the extension independently refuses any zoho_api POST/PUT
  job without an approval_id or task_order_id linkage - even if the server were tricked.
  The claim route also refuses to hand such jobs out unless the linked order/approval is
  approved.
- **Never-send guard** (structural, in the extension): trusted CDP clicks are checked at
  the live elementFromPoint target before dispatch - visible Send controls are blocked
  unless the target is a Schedule control; browser_eval temporarily wraps window.fetch to
  reject send-now-looking endpoints and installs capture-phase click guards in the top
  document and bound iframe; Ctrl/Cmd+Enter key dispatch is refused. Blocked actions return
  "send-now is blocked; schedule instead" so the model self-corrects toward scheduling.
- **Verification receipts**: after every mutating zoho_api call, the SERVER (not the model)
  automatically queues a GET read-back of each touched record, compares the written fields,
  and attaches receipts { status: verified | write_ok_unverified | failed, zoho_id,
  verified_fields, correlation_id, method, elapsed_ms, error } to the tool result.
  complete_task_order refuses a write order whose mutating calls produced zero receipts,
  and refuses composer-mutating orders without a recorded scheduled-email verification.
- **Signature protection**: browser_eval snapshots #ecw_signature before running model
  code and restores it if removed; instructions forbid replacing the editor's innerHTML.
- **Grep-proof tests**: unit tests literally read the extension source and assert
  invariants as regexes - e.g. the API runner has exactly one fetch path confined to
  GET/POST/PUT, no focused:true/active:true/windows.update (background window stays
  background), the send guard file exists and is consulted on the input paths. Plus ~48
  behavioral tests over the pure decision helpers (claim gating, budgets, schema
  validation, receipt comparison, recovery policy).
- **Audit trail**: every tool call, job claim/report, approval decision, order lifecycle
  event, guide update, and blocked action writes an audit_events row.

## 6. Knowledge layer

Skill guides are versioned Supabase rows following your workflows-as-skills template:
intent, preferred method (internal API via #token with exact endpoints/field names,
copy-paste JS), UI fallback described by landmarks not brittle selectors, gotchas,
verification, stop conditions. Current guides: email-scheduling (v7-ish, embeds your
verified chip-commit recipe), task-create-complete, deals/contacts/accounts editing,
zoho-facts. The server auto-routes relevant guides into the prompt by intent keywords;
the model can also list/read them explicitly, and after novel work it proposes
save_skill_guide updates (learn-by-doing). Selectors in guides are hints to confirm
against the live DOM, not scripts.

Accumulated Zoho gotchas encoded in guides/instructions: empty search returns HTTP 204;
parentheses break search criteria (use starts_with + client filter); Deals are "Potentials"
in URLs; the SPA renders after network-idle so identity checks must wait for the rendered
title; the UI-only Deals/Activities_Chronological_View relation 400s via API - use
/crm/v3/Tasks paged and filter by What_Id; recipient chips commit ONLY on Enter-keydown
while the input is focused (blur orphans text; leftover text corrupts the next address);
chips must be compared by their email attribute, not label; Zoho pre-fills the record's
contact as a committed To chip; the Cc input exists only after clicking the Cc reveal;
schedule popup time labels are zero-padded; post-midnight times roll to the next day;
composer body lives in a same-origin iframe; the schedule flow ends with "Schedule &
Close" and is verified in the record's Emails -> Scheduled list.

## 7. History - why the architecture flipped (this is where your input landed)

Phases A-E built the loop, the extension bridge, gated writes, hardening, budgets.
Phase F added teach mode / saved UI workflows / CDP input. Phase G added autonomous task
orders, browser_eval/observe, skill guides, undo.

Then we over-corrected: to fix latency and flakiness we built a deterministic email
pipeline - schedule_zoho_email_batch resolved the batch server-side and ran a fixed
extension script per record (task prep via API -> navigate -> verify deal -> open composer
-> chips -> subject -> body -> schedule -> verify), with no model calls between records,
receipts, deterministic retries, and finally a policy that stripped recovery tools from
the model after the worker failed. Three consecutive live runs then failed on three
different brittle-script defects (SPA identity wait; the unsupported activity relation;
recipient chip commit) and each failure dead-ended because the executor was a fixed
program the model could only watch. A simple one-email-two-task request burned 50+ tool
calls across two systems doing the same job.

Your "agent-first, not workflow-first" doc named the trap precisely (task-specific tools =
the workflow baked into code). We flipped: the model now drives execution through the
general primitives above; deterministic code shrank to gates, budgets, receipts, and the
send guard; playbooks became knowledge. The deterministic pipeline is removed from the
model surface and slated for deletion.

First live run on the new architecture (2026-07-12): resolved all records via zoho_api
GETs, correctly adopted both tasks as already in the desired state (no duplicate writes),
self-recovered from two failed clicks by inspecting the page and finding the real Compose
Email control, filled subject and body above the preserved signature - then stopped on a
FALSE recipient ambiguity: Zoho's pre-filled To chip was the correct recipient, the agent
re-typed the same address creating a transient "Loading" chip, compared labels instead of
email attributes, and refused to schedule. 26 tool calls, ~5 minutes, order completion
correctly refused by the verification gate. The chip-method fix (compare email attributes,
wait out unresolved chips, reconcile the pre-filled chip, dedupe) is being applied to the
instructions and the email-scheduling guide.

## 8. Known open items

- Chip reconciliation method fix (above) - in progress.
- read_workspace_file failed at the start of the last two runs (agent recovered because
  attachment content reached it another way) - under investigation.
- Composer-driving browser jobs are extension-gated only when the tab shows a composer;
  watched interactive steps stay ungated by design.
- Scheduled-email verification is detected server-side from read-back shapes; an explicit
  record_schedule_verification tool is a considered alternative.
- Old deterministic pipeline code awaits a deletion pass with test retirement notes.
- Turn budgets were raised for agent-first (a 26-call turn is now normal); order budgets
  and Stop remain the real limiter.

## 9. What we want from you

1. Critique the overall approach with fresh eyes. Where is this still workflow-first in
   disguise? Is anything here over-engineered relative to how you operate?
2. The gating trade-off: we hard-gate CRM writes (approval/task-order + extension refusal
   + receipts) where you rely on discipline + preview + verification. Given a
   non-developer end user, would you loosen or restructure any gate? Which gate would you
   remove first if latency became the complaint?
3. The receipts design: server-driven automatic read-back after every mutating API call,
   plus completion refusal without receipts. Sound? Overkill? Better shape?
4. The send guard: elementFromPoint label check before trusted clicks, fetch wrap +
   capture-phase click guards during eval, modifier+Enter refusal. Any accidental-send
   vector we missed? Any false-positive risk that will block legitimate scheduling?
5. The composer chip plan (email-attribute comparison, bounded wait for unresolved chips,
   reconcile pre-filled chip, dedupe extras, stop only on true mismatch) - does this match
   your live experience? Anything else the composer will throw at us before "Schedule &
   Close"?
6. Model economy: typical request today = ~20-26 tool calls. What would you cut? Where do
   you batch observations vs act one-step-at-a-time?
7. Anything you would add to the knowledge layer or the soul prompt that we clearly have
   not learned yet?

Answer in Markdown. Be blunt; disagreement is more useful than validation.
