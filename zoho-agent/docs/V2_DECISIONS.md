# V2 Decisions

## Agent chat attachments: plus-button context files (2026-07-11, build)

Added a composer plus button in /agent for Markdown, text, CSV, and TSV context files. Files are read client-side, shown as removable chips, and folded into the submitted user message inside explicit ATTACHED FILE blocks so the agent can parse Claude-written drafts or batch instructions in the same turn. The visible chat bubble stays compact by listing only the attachment names.

Guardrails: max four files per message, 750 KB per file, text-only/NUL rejection, no new database write path, and no broad filesystem access. This complements read_workspace_file for repo-local drafts while giving Aryan a direct chat upload path.

## Snap-like agent rewrite Step 4: write feedback drives live read-back and mirror sync (2026-07-11, build)

The prompt already told the model to sync Supabase after verified Zoho writes, but that instruction could be skipped during long autonomous loops. Added a server-side tool-result follow-up for successful Tier-2 Account/Contact/Deal writes. The result now explicitly marks live_readback_required and mirror_sync_required, then names the required next actions: zoho_get_record for the authoritative live fields and db_sync_records using exactly the returned live records.

This intentionally does not auto-write invented mirror data. Failed writes receive no sync directive. One-off approval-card writes, auto-approved writes, and task-order writes all use the same follow-up helper.

Verified npm run test:orchestrator (21/21), npm run typecheck, and npm run lint.

## Snap-like agent rewrite Step 3: harness budgets that permit real tool loops (2026-07-10, build)

Found a harness contradiction: task orders carried reviewed defaults of 200 calls/45 minutes, but runAgentTurn always stopped at the global 15 calls/3 minutes first. This made the larger task-order budget decorative and prevented the multi-tool feedback loop requested in BUILD_AN_AGENT_LIKE_SNAP.md.

Raised watched/non-order defaults to env-tunable AGENT_MAX_TOOL_CALLS=60 and AGENT_TURN_TIMEOUT_MS=900000 (15 minutes). During an approved task order, the loop now raises its effective limits to at least that order's max_tool_calls/max_wall_ms while continuing to enforce taskOrderBudgetDecision server-side for order calls, records, and wall time. Limits only increase within a turn so a long completed batch still gets a final model/report pass. The session turn lock now covers max(interactive timeout, task-order wall timeout) plus approval wait, preventing overlap during a 45-minute order while remaining self-healing.

This is deliberately bounded rather than literally uncapped: task budgets, Stop behavior, failure-rate stops, record limits, and env overrides remain safety controls.

Verified npm run test:orchestrator (20/20), npm run typecheck, and npm run lint.

## Snap-like agent rewrite Step 2: safe workspace file reading (2026-07-10, build)

The Phase G prompt required parsing imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md, but the agent had no file-reading tool and therefore could not actually satisfy the acceptance flow from a goal alone. Added read_workspace_file as a Tier-0 general primitive. It reads .md/.txt/.csv/.json only from imports/samples, source_docs, workflows, or reference/heysnap; rejects absolute paths, traversal, disallowed extensions, directories, binary/NUL content, and files over 2 MB; and returns at most 6,000 characters per page with line metadata and next_start_line.

The agent prompt now requires following next_start_line through every required page and forbids claiming a file was parsed from its name or a truncated first page. Regression coverage reads the real Batch 3 drafts and proves traversal/extension refusal. This deliberately adds read-only input capability, not Snap's arbitrary shell or unrestricted filesystem writes. Verified npm run test:orchestrator (19/19), npm run typecheck, and npm run lint.

## Snap-like agent rewrite Step 1: autonomy and data-source routing contract (2026-07-10, build)

Reviewed BUILD_AN_AGENT_LIKE_SNAP.md supplied by Aryan. Reframed the agent prompt around a feedback-driven goal loop: internally plan, choose a tool from current evidence, inspect the real result, adapt, and continue until verified completion or a true stop. The model must not ask the user which source/tool/endpoint/tab/selector or obvious sub-step to use. Partial/empty/truncated output triggers narrowing, pagination, re-observation, authority escalation, or another allowed primitive rather than immediate defeat.

Added explicit autonomous source policy for this stack: Supabase mirror first for fast discovery/bulk scope/ids/URLs; live Zoho for authoritative current state, conflicts, and all pre-write/read-back checks; deterministic tools before browser_eval; visible UI only for UI-only/watched work; live Zoho wins source conflicts; verified mirrorable Account/Contact/Deal changes flow back through db_sync_records. Task-order previews retain the approvals_enabled behavior (card when ON, auto-approved work log when OFF).

Intentional adaptation from Snap rather than literal copying: keep the reviewed deterministic CRM primitives, safe structured Supabase queries, extension allowlists, task budgets, no-delete rule, schedule-never-send, and approval flag. Do not expose raw SQL, arbitrary server shell, or unrestricted filesystem writes merely to imitate another harness. Verified npm run test:orchestrator (18/18), npm run typecheck, and npm run lint.

## Phase G live defect fix: observable composer read-back (2026-07-10, build)

Live retry opened the Emails area but again reported that composer fields could not be verified. browser_observe previously returned labels/selectors but not input values, omitted Zoho's committed recipient chips, and emitted generic navigation controls before useful dialog/iframe evidence; truncation made that worse.

browser_observe now emits a compact composer object before the general control dump with committed to_chips/cc_chips, safe current To/CC inputs, subject, body_text, signature_present, and signature_text. General controls expose safe values and prioritize composer/dialog/iframe evidence; password input values are never captured. The compact composer summary and verification_hint remain top-level even when the 16 KB observation is truncated. Agent instructions and the email guide require this summary first, then one targeted read-only eval before claiming verification is impossible. Verified npm run typecheck, npm run lint, npm run build:extension, generated-bundle composer/password checks, balanced SQL dollar quoting, and embedded recipe syntax.

## Phase G live defect fix: browser eval/observe require the dedicated Chrome window (2026-07-10, build)

Live composer retry used the user's ordinary CRM window despite the accepted requirement that visible browser work run in a separate same-profile Chrome window. Root cause: extension isUiJob classified only ui_step/ui_workflow as visible work; browser_observe/browser_eval followed the quiet API path and could adopt any CRM tab. Stored tab ids also had no marker distinguishing an extension-created agent window from an adopted ordinary tab.

The extension now persists agentWindowDedicated=true only for windows it creates. ui_step, ui_workflow, browser_observe, and browser_eval all require, focus, and reuse that dedicated normal window; a legacy/adopted tab without the marker causes a fresh dedicated window to be created. Deterministic API session jobs remain quiet and may reuse an existing CRM tab without changing the visible watched-work contract. Verified npm run typecheck, npm run lint, npm run build:extension, and generated-bundle marker/job classification.

## Phase G live recovery: Home is not a composer stop condition (2026-07-10, build)

Live retry observed crm.zoho.com/crm/org890324941/tab/Home/begin and stopped even though the session already contained the exact deal id/URL. Restored the canonical record navigation rule that had been logged in Phase C/D decisions but was lost during the Phase G prompt rewrite. Agent instructions now require ui_step open_url to the known canonical record, identity verification, and continuation; Home/list/wrong-page state alone is not a stop. The email guide carries the same recovery sequence and only treats a missing composer as terminal after one known-record navigation plus re-observation.

browser_observe now returns a top-level recovery_hint on /tab/Home, including in truncated observations, so the immediate tool result reinforces the same behavior. Verified npm run typecheck, npm run lint, npm run build:extension, generated-bundle recovery text, balanced SQL dollar quoting, and extracted composer-recipe syntax.

## Deterministic backend routing for the four core playbooks (2026-07-10, build)

The four core seeded playbooks are deals-editing, contacts-editing, accounts-editing, and email-scheduling; zoho-facts and task-create-complete remain supporting guides. Replaced fuzzy-only current-message loading with explicit core intent routes. Email/compose/schedule/subject/recipient/CC/signature routes email-scheduling; deal/potential routes deals-editing; contact/person routes contacts-editing; account/company routes accounts-editing. Exact routed guides load first, with scoring used only to fill the remaining two-guide context budget.

Routing now falls back to the latest matching user message in the same session when the current turn is shorthand such as "try now". Every routed turn writes a skill_guides_loaded audit event with route source plus requested/loaded/missing names. If a required routed row is absent or the guide query fails, the prompt receives an explicit stop warning instead of silently attempting the workflow without its playbook. Regression coverage includes exact one-word email/deal/contact/account triggers, multi-guide email-contact intent, recent email carry-forward, and no-match behavior. Verified npm run test:orchestrator (18/18), npm run typecheck, and npm run lint.

## HeySnap correction adaptation: exact composer insertion recipe (2026-07-10, build)

Expanded the email-scheduling seed with a copy-ready browser_eval recipe derived from NUANCES_AND_CORRECTIONS (1).md. The stored guide now removes only stale body nodes before the top-level node containing #ecw_signature, normalizes leading/trailing blank lines, inserts body lines as Verdana 13.33px nodes, appends exactly two blank lines, inserts before the signature anchor, dispatches input, and returns body_text/signature_present/signature_after_body evidence. The top-level-anchor walk is intentionally safer than assuming #ecw_signature is always a direct #editorDiv child. Added a dated correction to Gotchas. Verified balanced SQL dollar quoting, git diff --check, and extracted/compiled the embedded recipe with Node new Function.

## HeySnap instruction-following and correction-memory adaptation (2026-07-10, build)

Reviewed INSTRUCTION_FOLLOWING_AND_MEMORY.md and NUANCES_AND_CORRECTIONS (1).md supplied from Aryan's HeySnap use. Adopted the parts compatible with the accepted Phase G architecture: narrow commands stay bounded while high-level goals remain autonomous; browser actions re-observe and ground against current visible/DOM state; missing or ambiguous targets are never silently substituted; prefilled content is edited surgically and verified; and user corrections trigger a full update of the existing skill_guide with a dated Gotchas rule instead of a duplicate. Automatic guide routing now scores gotchas/verification/stop conditions and recognizes email signature/spacing/font corrections. Injected guide context puts Gotchas first.

Deliberately not adopted: the blanket "one instruction = one action, always wait" rule. That would restore the Phase F one-step teaching constraint explicitly removed by Phase G. The adapted rule distinguishes a narrow imperative from a high-level goal. Verified npm run test:orchestrator (17/17), npm run typecheck, and npm run lint.

## Phase G live defect fix: enforce batch-only task orders (2026-07-10, build)

The watched one-record composer retry incorrectly proposed a task order, and its budget reported four records because expected_changes counted recipient/subject/body actions rather than distinct records. The server now accepts propose_task_order only for more than three distinct expected records or when the current user request explicitly asks for unattended/background execution. Otherwise the tool returns an observation telling the agent to continue directly. Record budgets now derive from distinct normalized record labels, with the existing 10 percent headroom. Added regression coverage for watched, unattended, batch, and repeated-action budget cases. Verified npm run test:orchestrator (17/17), npm run typecheck, and npm run lint.

## Phase G live defect fix: self-heal interrupted tool transcripts (2026-07-10, build)

After the composer turn, the next Codex request failed with HTTP 400 "No tool output found for function call". A turn interruption can persist an assistant function-call marker before its tool-result row, and the structured Responses serializer previously replayed that orphan. responsesInputFromMessages now emits structured function_call/function_call_output items only for call ids present on both sides. Orphan calls are omitted; orphan outputs are retained as plain TOOL RESULT context. Added regression coverage to the orchestrator test suite. Verified npm run test:orchestrator (16/16), npm run typecheck, and npm run lint.

## Phase G live defect fix: explicit browser_eval no-return result (2026-07-10, build)

The live composer eval changed fields but omitted return, and the runner converted undefined to null; the model then treated null as no evidence and incorrectly reported the visible work as not done. browser_eval now returns an explicit executed/returned=false/possible_state_change/verification_required observation when code omits return. Tool and agent instructions require state-changing evals to return exact JSON read-back values and require observation before retry or completion when returned=false. The email guide requires exact composer values plus signature_present=true in the fill result. Verified npm run typecheck, npm run lint, and npm run build:extension.

## Phase G live defect fix: preserve composer signatures (2026-07-10, build)

Live retry proved the eval did fill the composer despite returning null, but its whole-editor replacement removed the existing Zoho signature. browser_eval now finds and snapshots #ecw_signature across readable same-origin frames before model code runs, restores it if removed (including when code throws), and rejects that unsafe eval with an explicit result. Both CDP and DOM ui_step fill_field paths refuse to replace an editor containing the signature. Agent instructions and the email-scheduling seed now require inserting body nodes immediately before #ecw_signature, prohibit whole-editor innerHTML/textContent/replaceChildren and ui_step fill_field, and require signature read-back before scheduling. Verified npm run typecheck, npm run lint, and npm run build:extension.

## Phase G live defect fix: blank optional browser selectors (2026-07-10, build)

Live retry exposed browser_eval validation rejecting frame_selector="" even though the field is optional. Browser tool validation now normalizes an empty or whitespace-only frame_selector/scope_selector to omitted before applying the non-empty selector constraint. Non-empty selectors retain the 500-character bound.

## Phase G live defect fix: browser_eval could not reach the composer iframe (2026-07-10, chat)

Live run: "fill the open composer" -> browser_eval "Worked" but returned null twice; complete_task_order honestly reported "could not verify" (verification rules working as intended). Root cause: browserEvalPageRunner (extension/src/jobs.ts) runs the model's code in the TOP frame's MAIN world via new Function(code); Zoho's email composer body is a same-origin IFRAME (#z_editor per the seeded email-scheduling guide). The model's document.querySelector ran against the top document, found no composer fields, returned null. browser_observe was taught to descend into iframes in this phase, but browser_eval was not - so the model could see the fields and not touch them.

Fix (chat): browser_eval now accepts optional frame_selector. When present, the runner resolves that same-origin iframe's contentDocument and binds it to `document` inside the evaluated code (new Function("document", code) called with the frame document); `window` and `window.document` stay top-level. Eval code that also calls Zoho APIs must therefore read #token from window.document while frame_selector is set. Added frame_selector to browserEvalSchema + the tool JSON schema + the tool description (points the model at the composer body iframe). No frame injection needed - same-origin iframes are reachable from the top MAIN world. Verified npm run typecheck, npm run lint, npm run build, and npm run build:extension; reload the unpacked extension before live acceptance. Part of the pending Phase G review batch.

Note: new Function(code) executing at all means Zoho's page CSP allows eval in the MAIN world here (unlike the inline-script block from Phase B) - the null was frame scope, not CSP. If a future Zoho CSP tightening blocks new Function, browser_eval would need to move to CDP Runtime.evaluate; not needed now.

## Phase G follow-up hotfix: profile fallback before migration (2026-07-10, build)

Live issue: Settings -> Chrome extension token generation returned "User profile is not configured" when the cloud Supabase schema had not yet been migrated with `users.approvals_enabled`.

Fix: `requireApiRole` and `requirePageRole` now try the new `role,email,approvals_enabled` profile shape first, then retry the legacy `role,email` shape and default `approvals_enabled=false` if the new column is missing. This keeps existing Settings/token routes usable while the Phase G migration is being applied. Verification: npm run typecheck passed; npm run lint passed.

## Phase G follow-up Step 1: approvals flag and default ungated execution (2026-07-10, build)

Started the section 8 follow-ups by putting the reviewed gate machinery behind `users.approvals_enabled`, default false. Settings now exposes the flag, with admin-only edits.

When approval cards are off, Tier-2 API writes still build the normal before-value summary/snapshot, create an approved approval row, and enqueue a linked tool job so the extension's API-write refusal stays intact. Task orders auto-approve as budgeted work logs. browser_eval and watched UI jobs run immediately; claim-route and extension-side linkage checks were relaxed only for browser/eval/UI jobs, not for Tier-2 API writes.

Also fixed task-order Tier-2 writes to go through buildApprovalRequest before enqueueing, so batch/task-order writes now keep the same before-value evidence needed for audit and undo.

## Phase G follow-up Step 2: automatic guide context and real email guide (2026-07-10, build)

Added deterministic per-turn skill-guide routing. The agent now loads the top matching one or two guides into context before the model call; email/compose/schedule language routes to `email-scheduling` without the user asking.

Rebuilt the `email-scheduling` seed from the KD Blitz playbook section 9 selector map and the real acceptance drafts file format. It now records To/Cc chip selectors, real Enter commit, subject input, body iframe `#z_editor` -> `#editorDiv`, Verdana 13.33px body insertion above `#ecw_signature`, schedule-never-send flow, chip read-back, Scheduled-tab verification, and the manual Scheduled-tab path for non-revertible scheduled emails. The seed upsert now updates existing guide rows instead of doing nothing on conflict.

## Phase G follow-up Step 3: browser_observe frames and scoped overlays (2026-07-10, build)

Expanded `browser_observe` with optional `scope_selector`. The extension runner now observes the top document plus readable same-origin iframes, tags headings/controls with `frame` and `frame_selector`, marks dialog/overlay ancestry, and returns CSS-pixel coordinates adjusted back into the main viewport. This is intended to make the Zoho compose overlay and `#z_editor` body iframe visible to the agent without increasing the 16 KB result cap.

## Phase G follow-up Step 4: undo tools and task report button (2026-07-10, build)

Added `undo_record` and `undo_task` agent tools. Undo reads approved `pending_approvals` summaries, reconstructs field/owner/tag reverts from logged before-values, and runs those reverts through the existing Tier-2 write path so cards, auto-approval, read-back verification, extension API-write linkage, and audit behavior remain centralized. Task-order undo runs newest-first and reports scheduled emails as non-revertible with the manual Scheduled-tab path.

Added an Undo task button to expanded `complete_task_order` tool reports in the chat. The button sends a normal chat message (`Undo task <id>`) so the undo remains visible in the transcript and goes through the same agent tools.

## Phase G follow-up final verification (2026-07-10, build)

Automated verification for section 8 items 1-7 follow-ups:
- npm run typecheck passed.
- npm run lint passed.
- npm run build passed.
- npm run build:extension passed.

Stopping for chat review before declaring Phase G follow-ups done. Live acceptance remains the real localhost flow: approval cards off by default, "click Compose Email" auto-loads the email guide, browser_observe sees the compose overlay/iframe, and the KD Blitz drafts file asks only for the TBD schedule date before an auto-approved budgeted task order.

## DECISION: all approval gates OFF by default (Aryan, 2026-07-10)

Follow-on from the same-day interactive-ungating decision. Aryan: "people are already giving specific instructions and there's nothing that cannot be undone so why have them." ALL approval cards are removed from the default experience - including batch task orders and Tier-2 API write cards.

Implementation rule (chat): do not delete the reviewed gate machinery; put it behind a per-user setting `users.approvals_enabled` (default FALSE). When FALSE: Tier-2 API writes, batch tasks, eval, and UI steps all execute immediately; task orders auto-approve (still recorded, still budgeted, still reported). When TRUE: prior behavior. Flipping the flag is a settings change, not a rebuild - intended for future teammates.

What REMAINS regardless of the flag (these are what make "undoable" true, so they are not optional): before/after capture on every write; read-back verification; full audit incl. eval code; stop conditions (identity mismatch, Zoho errors, logged out, 3-fail/20%); schedule-never-send; no deletes; org/module allowlist; budgets on batch runs. Chat's on-record caveat: the one irreversible action in scope is a scheduled email that actually SENDS to a real recipient before a mistake is noticed - schedule-never-send plus verification of recipient/date/time in the Scheduled view is the remaining protection there.

Follow-up accepted by implication of Aryan's undoability argument: build an UNDO capability - per-record and per-task revert using the logged before values (fields/owner/tags). Specced as Phase G section 8 item 6.

## DECISION: interactive browser work is ungated; guides auto-load; observe must see the composer (Aryan, 2026-07-10, after first Phase G live run)

Live run: "type this in the open composer" produced a task-order approval card for three typing actions, then failed with "UI target was not found" (composer fields are inside Zoho's compose overlay/iframe; browser_observe does not descend into frames; no guide was in context).

Aryan's decisions:
1. NO approval cards for interactive browser work. ui_step, browser_observe, and browser_eval run immediately when the user is directing the session - the user watching the dedicated window IS the approval. This extends the 2026-07-10 full-eval decision; chat's earlier per-task-card compromise is narrowed: propose_task_order (one card) remains ONLY for unattended/batch multi-record tasks (e.g. the 50-email file), and Tier-2 API write tools keep their existing per-call cards when used outside an order. Teach mode stops being a permission gate; it remains only as a walkthrough label that triggers guide drafting.
2. Guides must load AUTOMATICALLY by intent: email work (e.g. clicking Compose) must pull the email-scheduling guide into context without being asked - deterministic keyword/intent routing plus the read_skill_guide tool for depth. The KD Blitz playbook section 9 selector map and composer gotchas must be in the seeded email guide.
3. The Chrome debugger banner is acceptable; CDP control preferred where it is more reliable.

Risk note (chat, on record): with interactive eval/UI ungated, protection for interactive sessions = visibility of the driven window + audit + verification + stop conditions + the schedule-never-send / no-delete instructions; the remaining hard gates are batch task orders and API-write cards. Aryan accepted this explicitly.

## Phase G Step 5: learn-by-doing rule and final build verification (2026-07-10, build)

Tightened the learn-by-doing prompt rule: after completing any task with no matching guide, the agent must draft everything needed to redo the task without being walked through, including params for values that vary, then propose save_skill_guide behind a confirmation card.

Final automated verification for the Phase G build:
- npm run typecheck passed.
- npm run lint passed.
- npm run build passed.
- npm run build:extension passed.
- npm run test:orchestrator passed 15/15.
- npm run test:tier2 passed 15/15.

Stopping for chat review before declaring Phase G done. Live acceptance remains the spec section 7 scenarios.

## Phase G Step 4: skill guides and Guides tab (2026-07-10, build)

Built workflows-as-skills:
- Extended supabase/2026_v2_phase_g.sql with skill_guides, read RLS, service-role write policy intent, update trigger, and seed rows for zoho-facts, deals-editing, contacts-editing, accounts-editing, email-scheduling, and task-create-complete.
- Seed guides convert the playbooks/reference facts into intent, preconditions, Method API, Method UI, gotchas, verification, stop conditions, and params.
- Added list_skill_guides, read_skill_guide, and save_skill_guide tools. save_skill_guide uses a confirmation card and version bump, then audits skill_guide_saved/updated.
- Added /workflows Guides tab beside legacy workflows. Guides list/detail/edit is available to admin/operator users, and edits go through /api/skill-guides/[id] with validation and audit.
- Updated AGENT_INSTRUCTIONS to discover/read relevant guides before task classes and propose save_skill_guide after novel work.

Verification for this step: npm run typecheck passed.

## Phase G Step 3: browser_observe and autonomous instructions (2026-07-10, build)

Built the observation/autonomy slice:
- Added browser_observe as an ungated read-only browser primitive. It reports the current CRM URL, title, visible headings, and visible interactive controls from the page MAIN world, capped to about 16 KB.
- Removed the Phase F one-step-per-instruction teaching rule from AGENT_INSTRUCTIONS. Teach mode is now a watched walkthrough mode where the agent can observe, act, and verify toward a user goal.
- Rewrote AGENT_INSTRUCTIONS around the HeySnap loop: observe -> reason -> act -> verify; deterministic tools first, browser_eval when deterministic tools do not fit, UI automation last; task-order approval scope; verification/read-back; stop conditions; and concise task-level reporting.
- Server-side UI gating now lets ui_step run without teach mode only under an approved task order. Mutating ui_step calls outside an approved task order are rejected even in teach mode.
- Claim route and extension now refuse manually inserted mutating ui_step jobs unless they carry approval_id or approved task_order_id.

Verification for this step: npm run typecheck passed; npm run build:extension passed.

## Phase G Step 2: browser_eval gated browser primitive (2026-07-10, build)

Built browser_eval end to end:
- Added browser_eval { purpose, code, await_promise } as a Tier-2 browser primitive. The full code remains in agent_messages tool_args; server audit stores purpose, sha256(code), byte length, approval_id, task_order_id, and ok/error.
- Under an active approved task order, browser_eval queues a tool_job with task_order_id. Outside an order, the agent emits a per-call approval card showing purpose, code hash, byte length, and full code; the waiting loop queues the job only after approval.
- The approval route treats browser_eval as a local/waited approval so it never auto-enqueues a job without the loop's audit context.
- The extension claim route refuses browser_eval unless approval_id is approved or task_order_id points at an approved task order.
- The extension runs browser_eval in the crm.zoho.com MAIN world with chrome.scripting.executeScript, returns JSON-serializable results, caps output at 64 KB, and refuses unscoped eval jobs as defense in depth.

Verification for this step: npm run typecheck passed; npm run build:extension passed.

## Phase G Step 1: task orders and per-task approval scope (2026-07-10, build)

Built the first Phase G slice:
- Added supabase/2026_v2_phase_g.sql with task_orders, report storage, one active approved order per session, tool_jobs.task_order_id, and explicit approval_id drift coverage.
- Added propose_task_order and complete_task_order. Read orders auto-approve; write orders create one task_order approval card and activate only after approval. task_order approvals do not enqueue extension jobs.
- Added task-order budgets with env defaults TASK_ORDER_MAX_TOOL_CALLS=200 and TASK_ORDER_WALL_MS=45 min. The loop fails approved orders when tool-call, wall-clock, or record-touch budgets trip.
- Under an approved task order, Tier-2 writes enqueue with task_order_id and skip per-call cards. Outside an order, the old per-call approval path remains unchanged.
- The extension claim route only hands scoped write jobs to the extension when approval_id is approved or task_order_id points at an approved order. The extension refuses writes lacking both ids.
- The chat Stop button now calls a server stop endpoint before aborting the stream; the endpoint fails active orders, expires queued scoped jobs, clears the turn lock, and audits the stop.

Verification for this step: npm run typecheck passed; npm run build:extension passed; npm run test:orchestrator passed 15/15; npm run test:tier2 passed 15/15 after rerunning unsandboxed for the known Windows .tmp write restriction.

## DECISION: Phase G - task autonomy, full browser_eval, per-task approval, skills-as-guides (Aryan, 2026-07-10)

Context: live teaching felt like a grind (one ui_step per instruction, dictated selectors) and Aryan compared notes with HeySnap, whose hand-off docs now live in reference/heysnap/. Aryan decided, with the risk explicitly explained and accepted:

1. Task-level autonomy: hand the agent a whole task (e.g. a 50-email drafts file) and it executes end to end without per-step confirmation.
2. FULL browser_eval (arbitrary model-written JS in the logged-in CRM page). This SUPERSEDES the migration spec section 8.4 rule "no arbitrary code execution tool". Chat recommended against; Aryan chose it knowingly. Mitigations: task-order approval scope, full code in the audited trace, verification and stop conditions, crm.zoho.com-only execution.
3. Approval granularity moves from per-action to PER TASK: one preview/approval card covering the whole task's expected changes, then unattended execution. The locked rule "preview + approval before CRM changes" stands - it is satisfied once per task. Reads stay ungated.
4. Workflows become agent-authored skill guides (intent/method/gotchas/verification, learn-by-doing after one walkthrough), read on demand; frozen step replays demoted to legacy.

Spec: workflows/SPEC_v2_phase_g_autonomous_agent.md (v1.0). Codex builds in its section 6 order; chat review will focus on the task-order gate (no eval or write job without an approval_id or an approved order id, extension-side belt included), budget enforcement, and audit completeness.

## Review: CDP input + workflows management (2026-07-10, chat review)

Reviewed aad9ecf (CDP trusted UI input) and a84852f (workflows management surface). Verdict: approved, one safety edge fixed by the reviewer. Verified from the object store: tsc clean; orchestrator 14/14, tier2 15/15, records untouched; extension CRM write methods still only in page-runner-write.ts; "debugger" permission added as specced.

CDP implementation is spec-conformant and careful: attach 1.3 per job / detach in finally; locateUiTarget is closure-free, scrolls into view, returns CSS-px centers (no devicePixelRatio multiplication - correct per reference section 6), composes iframe offsets via frame_selector; trusted mouseMoved->Pressed->Released; fills via focus click + Ctrl+A + Input.insertText (works for contentEditable, i.e. the email body); DOM path kept as labeled dom_fallback with the CDP error preserved; click results marked needs_verification and the teach instructions now require a wait_for/confirm/verify step after every click before claiming success. frame_selector was added to the schemas AND to the param-injection guard (params cannot reach it) - good catch by the builder.

Management surface: /workflows list+detail, param-form run handoff into /agent chat (execution keeps every existing gate), PATCH validates through the SAME prepareUiWorkflow path, structure changes bump version and reset trusted, creator-or-admin mutation guard, typed-name delete confirm, audits (workflow_saved/updated/deleted incl. from the agent save path).

Fix (reviewer, app/api/workflows/[id]/route.ts): effect downgrade on edit. PATCH recomputed effect purely from steps, so a workflow deliberately saved as effect=write with no mutating-looking steps would silently become read on ANY edit (even a description tweak), removing its approval gate. Effect now only upgrades via re-derivation, never downgrades; removing a gate requires delete + re-teach.

Non-blocking: (1) locateUiTarget reads the iframe rect before the inner scrollIntoView - if the outer page scrolls as a side effect, coordinates could be stale; re-read the frame rect after scrolling if composer clicks ever land off-target. (2) fill_field results carry the intended value as observed (not a read-back); verify_field remains the proof - consistent with the click rule, fine. (3) Chrome shows the debugging infobar during CDP steps - expected, documented for users.

Live acceptance for this batch: the previously failing sequence (open deal -> Emails section -> Compose Email) must now visibly open the composer; /workflows shows saved workflows and the run handoff pre-fills the chat; editing a step resets trusted and forces a new test replay; deleting requires typing the name.

## Phase F follow-up: workflows management surface (2026-07-10, build)

Built the workflow library UI from spec 4.6:
- Added /workflows for admin/operator users with saved workflow list, effect/trusted badges, version, params, updated_at, detail steps, run param form, edit form, and typed-name delete.
- Run handoff goes to /agent?draft=... and pre-fills the chat composer. Execution still happens only through the existing agent tools, replay path, teach-mode checks, trusted replay handling, and write approval gate.
- Added /api/workflows list plus /api/workflows/[id] update/delete. Updates reuse prepareUiWorkflow validation and re-derive effect server-side with workflowEffectForSteps. Step/effect edits bump version and reset trusted=false; metadata edits keep the current trust/version.
- Delete is local-row only, role/ownership checked, service-role backed, and requires the exact workflow name.
- Added audit events for workflow_saved, workflow_updated, and workflow_deleted. Agent instructions now call list_ui_workflows for "what workflows do I have" / "how do I run X" and answer with names, params, and an example run phrase.

Verification for this follow-up: npm run typecheck passed; npm run lint passed; npm run build passed after rerunning unsandboxed for the known Windows .next trace write restriction; npm run build:extension passed; npm run test:orchestrator passed 14/14 after rerunning unsandboxed for the known Windows .tmp write restriction.

## Phase F follow-up: CDP-trusted UI input (2026-07-10, build)

Built the blocking live-teach fix from the diagnosis entry:
- Added the Chrome debugger permission and a background-worker CDP input path for ui_step click, fill_field commit, and press_key.
- Trusted click/fill/keypress uses Input.dispatchMouseEvent, Input.dispatchKeyEvent, and Input.insertText at CSS-pixel coordinates derived from the visible target. The debugger attaches for the input operation and detaches in finally.
- DOM-event execution remains as an explicit fallback and reports input_method=dom_fallback plus the CDP error in the result.
- Click results report input dispatched with verified=false/needs_verification=true; teach instructions now tell the model to propose a wait_for/confirm_text_present/verify_field step after every click instead of claiming the UI changed from the click alone.
- Added optional frame_selector for UI steps so the Zoho email composer iframe (#z_editor) can be targeted. Server validation still blocks params in selector and frame_selector fields.

Verification for this follow-up: npm run typecheck passed; npm run build:extension passed; npm run test:orchestrator passed 13/13 after rerunning unsandboxed for the known Windows .tmp write restriction.

## Live-teach diagnosis: Zoho ignores untrusted clicks; CDP input required (2026-07-10, chat)

Aryan's first real teach session: open_url worked, but click steps ("Emails section", "Compose Email") reported ok with no visible effect. Two root causes. (1) Synthetic MouseEvents + element.click() have isTrusted=false and Zoho's UI ignores untrusted input on many controls - exactly what reference/ZOHO_SESSION_API_REFERENCE.md section 6 warned about ("use CDP-level input for hover-reveal controls, exact-coordinate clicks, Enter-to-commit"; learned originally from HeySnap, which drives pages through chrome.debugger / CDP trusted input). (2) The click step reports success when events dispatch, without verifying any effect, so failures look like "Worked".

Follow-up specced to Codex (chat prompt, 2026-07-10): chrome.debugger-based Input.dispatchMouseEvent/dispatchKeyEvent for click/fill-commit/press_key (attach per job, detach in finally, DOM-event fallback, CSS-px coordinates, tolerate the debugging infobar), honest click results (unverified until a wait_for/confirm passes; teach instructions updated accordingly), and iframe targeting for the email composer. Localhost-only and all gates unchanged.

## Review of Phase F follow-ups (2026-07-10, chat review)

Reviewed 2d97ea3 (teach-mode prompt wording), aa17891 (per-turn teach_mode state in the prompt), 4a17c7b (dedicated Chrome window + UI targeting improvements). Verdict: first two approved as-is (per-iteration DB re-read of teach_mode keeps the prompt current mid-turn; server-side enforcement untouched). Third approved with two reviewer fixes; its targeting improvements (visible-elements-only, exact-text-match preferred, scrollIntoView) close the earlier findByText review note.

Fix 1 (extension/src/jobs.ts): focus stealing on every job. crmTabForJob focused the dedicated window and activated its tab for ALL claimed jobs, so every background Tier-1/2 API session call would yank Chrome focus from whatever the user was doing. Now only UI jobs (ui_step / ui_workflow) focus the window (they drive the visible page, and captureVisibleTab needs the active tab of the focused window); API jobs reuse the stored agent tab or any open CRM tab QUIETLY, and if no CRM tab exists anywhere the dedicated window is created unfocused. UI-job precedence is preserved: dedicated window first, arbitrary tabs only as fallback.

Fix 2 (extension/src/page-runner-ui.ts): double-click. mouseClick dispatched a synthetic "click" MouseEvent AND then called element.click(), firing every click handler twice - toggles/menus/checkboxes would open-then-close or check-then-uncheck. Now: synthetic mouseover/mousedown/mouseup for hover-reveal behavior, then exactly ONE click (native HTMLElement.click(), or a single synthetic click for non-HTML elements).

Notes: AGENT_WINDOW_HOME hardcodes a deals custom-view URL - harmless (initial page only), simplify to the plain tab URL if the view id ever changes. The isVisible filter means selectors matching hover-hidden elements now fail instead of clicking invisibly; taught flows should add a hover/click step to reveal such controls first (playbook-consistent).

Verified: tsc --noEmit clean with both fixes over 4a17c7b. Requires npm run build:extension on the dev machine + extension reload; no server or DB change.

## Phase F follow-up: dedicated visible Chrome window (2026-07-10, build)

Observed during live testing: with multiple CRM tabs/windows, the extension could claim the first crm.zoho.com tab returned by Chrome and the user could not reliably see which page was being driven. Added a dedicated Zoho Agent Chrome window: the first extension-backed browser job creates a normal focused CRM window in the same Chrome profile, stores its window/tab ids, and later jobs reuse/focus that window. UI clicks now prefer visible exact text matches, scroll targets into view before clicking/reading/filling, and use a native HTMLElement click after mouse events.

Verification for this follow-up: npm run typecheck passed; npm run build:extension passed after rerunning unsandboxed for the known extension/dist write restriction.

## Phase F follow-up: expose teach_mode to the model (2026-07-10, build)

Observed during live testing: even with Teach a workflow enabled, asking "open this deal" could still get a cautionary response asking the user to enable teach mode. Root cause: the loop enforced teach_mode server-side, but the model prompt did not include the current session's teach_mode value. Added a per-turn DB read of agent_sessions.teach_mode and appended explicit state to the tool prompt: when ON, crm.zoho.com open/navigate requests should call ui_step open_url; when OFF, ui_step must not be called.

Verification for this follow-up: npm run typecheck passed.

## Phase F follow-up: teach-mode open_url instruction (2026-07-10, build)

Observed during live testing: asking the agent to "open this deal" returned the CRM link instead of calling ui_step. Root cause was stale wording in AGENT_INSTRUCTIONS that said "UI actions remain unavailable" immediately before the teach-mode ui_step guidance. Updated the prompt to keep deletes/record creation unavailable while explicitly telling the model to use ui_step open_url for crm.zoho.com URLs when teach mode is on.

Verification for this follow-up: npm run typecheck passed.

## Phase F review (2026-07-10, chat review)

Verdict: approved pending live acceptance; two defense/honesty fixes applied by the reviewer; no slop. Verified independently from commit 4d0281d (git archive to /tmp; mount not trusted): tsc --noEmit clean; orchestrator 13/13, tier2 14/14 (15/15 after the reviewer-added test), records 5/5. Grep-proofs: CRM API writes still ONLY in page-runner-write.ts; page-runner-ui.ts is DOM-only (zero fetch calls, closure-free); tool_jobs inserts unchanged (approvals route + bridge, both guarded); no Vercel/deploy artifacts anywhere - localhost boundary respected; extension manifest hosts unchanged.

What passed hard scrutiny: turn lock (step 0) is correct - pre-check + ATOMIC guarded claim (or-condition on null/expired turn_active_until, Postgres re-evaluates the WHERE under row lock so a concurrent POST loses and 409s), cleared in finally even when the client disconnects mid-stream, self-healing expiry = turn budget + 15 min approval wait. Teach mode is server-enforced at execution time (ensureTeachMode re-reads the session row for both ui_step and save_ui_workflow - toggling teach mode off mid-turn takes effect immediately). Param substitution is injection-safe: params allowed only in url/value/text/equals, selectors reject {} at save time, and every substituted step is re-parsed through the STRICT step schema, so a param cannot redirect open_url off crm.zoho.com. Save-time effect classification: any click/fill_field/press_key forces effect=write (press_key too - stricter than the spec asked). save_ui_workflow approvals do NOT enqueue an extension job (approvals route special-cases them; the waiting loop does the local upsert). Write-effect replays go through the full Phase D approval machinery; trusted flips only after a fully verified replay. open_url is double-checked (Zod at save + background executor re-parses hostname). Screenshot evidence capped 500 KB. Recorder mode deferred with a logged commit, per spec.

Fix 1 (reviewer, lib/agent/loop.ts): replay result honesty. Both replay paths reported tool-level ok even when the workflow failed mid-step (extension reports the job "done" with an inner ok:false + failed_step_index). The trace showed "Worked" and the model could claim success for a failed replay. Both paths now derive ok from the verified-replay check (same predicate that gates the trusted flip).

Fix 2 (reviewer, claim route + tier2-tools + extension jobs.ts): approval-gate parity for write-effect ui_workflow jobs. The claim route's belt-and-braces only recognized the four zoho_* write names, so a write-effect ui_workflow job was handed out without checking its approval row (the extension's own args.effect check was the only guard). Added approvalGatedClaimDecision (pure, unit-tested; tier2ClaimDecision now delegates to it) and the claim route applies it when tool_name=ui_workflow and args.effect=write. Extension additionally refuses an unapproved replay when ANY step is click/fill_field/press_key, regardless of the effect label (do not trust the label if the two ever disagree). No behavior change for legitimate flows; server-side the chain was already closed (effect comes from the saved workflow row, saves are card-confirmed, job inserts are service-role only) - this is defense in depth.

Non-blocking notes: (1) a manually inserted ui_step job would execute without teach-mode context (service-role-only insert paths make this unreachable today; consider a claim-route teach-mode check if job insert paths ever widen). (2) page-runner-ui findByText scans a broad selector list and picks the FIRST match - fine for teaching (user watches), acceptable for replay because verify steps + stop-on-failure catch drift; revisit if replays misfire. (3) tsconfig.orchestrator-test now also compiles turn-lock/sweeps tests - fine.

Before live testing: run supabase/2026_v2_phase_f.sql in Supabase FIRST (adds turn_active_until + teach_mode), then npm run lint && npm run build && npm run build:extension && npm run test:tier2, reload the unpacked extension, restart the dev server. Live acceptance owed (spec section 5 / migration spec Phase F done-when): teach one real read workflow once, replay unaided on a DIFFERENT record; one write-effect workflow replays ONLY through an approval card; ui_step outside teach mode returns an error observation; turn lock 409s a second concurrent message; step failure stops the replay with screenshot evidence in the result.

## Phase F Build Verification: ready for chat review (2026-07-10, build)

Localhost-only boundary held: no Vercel/deploy config, production URL, manifest hosting change, or hosting refactor was made.

Final local verification after Step 6:
- npm run typecheck passed.
- npm run lint passed.
- npm run build passed after rerunning unsandboxed for the known Windows .next write restriction.
- npm run test:orchestrator passed 13/13 after rerunning unsandboxed for the known Windows .tmp write restriction.
- npm run build:extension passed after rerunning unsandboxed for the known extension/dist write restriction.

Grep-proof spot checks: tool_jobs inserts remain at the bridge and approval route only, both adjacent to assertTier2JobInsertAllowed; page-runner-write.ts remains the only extension page runner with Zoho PUT/actions writes; page-runner-ui.ts has no fetch/PUT/actions path. Extension manifest/package/env checked for production/deploy additions and none were found.

Chat-review/live acceptance still owed before declaring Phase F done: teach once on record A and replay unaided on record B; confirm write-effect workflow replay appears only as an approval card and executes only after approval.

## Phase F Step 6 Checkpoint: recorder mode deferred (2026-07-10, build)

Recorder mode is deferred deliberately after completing the mandatory guided teaching, save, read replay, and write replay gates:
- No recorder UI or raw-recording storage was added in this step.
- Because recorder mode is absent, there is no password-field capture path and no retained raw recording artifact.
- Guided teach mode remains the supported workflow teaching path for Phase F chat review.
- If recorder mode is revived later, it must be built from the spec constraints: Start/Stop in extension options, selector derivation id > name > shortest unique CSS path, never capture password fields, import into chat for cleanup, and discard raw recordings after save or discard.

Verification for this step: docs-only deferral; no runtime change.

## Phase F Step 5 Checkpoint: write-effect workflow replay approval gate (2026-07-10, build)

Implemented write-effect replay after committing Step 4:
- run_ui_workflow now handles both read and write saved workflows. Read workflows still bridge directly as ui_workflow jobs.
- Write-effect workflows create a pending_approvals card with the substituted step list before any extension job is queued. Reject/expiry returns an observation and does not execute.
- Approval uses the existing Phase D decision endpoint and approved tool_jobs path. The queued job carries approval_id and the immutable substituted steps exactly as shown in the card.
- The extension refuses any ui_workflow job with effect=write unless approval_id is present.
- Verified write-effect replay keeps effect=write through param substitution before the approval card.

Verification for this step: npm run typecheck passed; npm run test:orchestrator passed 13/13 after rerunning unsandboxed for the known Windows .tmp write restriction; npm run build:extension passed after rerunning unsandboxed for the known extension/dist write restriction.

## Phase F Step 4 Checkpoint: read-effect UI workflow replay (2026-07-10, build)

Implemented read-effect replay after committing Step 3:
- Added run_ui_workflow as the public replay tool. The server resolves a saved workflow by name, rejects missing or unknown params, substitutes params only into url/value/text/equals slots, and revalidates the substituted steps before queueing.
- Read-effect workflows are bridged as an internal ui_workflow extension job. Write-effect workflows are still rejected in this step and are routed through approval in Step 5.
- The extension executes ui_workflow one step at a time through the same ui_step runner, with crm.zoho.com enforced before page dispatch. open_url and screenshot remain background-side steps.
- Workflow replay stops on the first failed step and returns failed_step_index, step outcomes, and capped screenshot evidence. Successful replay also returns capped evidence.
- A successful verified read replay updates ui_workflows.trusted to true for that workflow version and reports trusted_before/trusted_after in the tool result.

Verification for this step: npm run typecheck passed; npm run test:orchestrator passed 12/12 after rerunning unsandboxed for the known Windows .tmp write restriction; npm run build:extension passed after rerunning unsandboxed for the known extension/dist write restriction.

## Phase F Step 3 Checkpoint: save and list UI workflows (2026-07-10, build)

Implemented the taught-workflow save surface after committing Step 2:
- Extended lib/agent/ui-tools.ts with save_ui_workflow and list_ui_workflows definitions plus Zod validation for workflow steps, params, and effect.
- Workflow params are allowed only in value/url/text-like slots. Selectors containing parameter braces are rejected before any confirmation card is shown.
- Any workflow containing click, fill_field, or press_key must be saved as effect=write. This prevents a mutating CRM workflow from being mislabeled as a read replay.
- runAgentTurn now lists saved workflows from ui_workflows as a DB read. Saving requires teach mode, creates a save_ui_workflow confirmation card, waits for approve/reject/expiry, and only then upserts ui_workflows with trusted=false and a version bump.
- POST /api/agent/approvals/[id] treats save_ui_workflow approvals as local confirmations and does not enqueue a tool_jobs row. CRM write approvals still use the existing Phase D job path with approval_id.

Verification for this step: npm run typecheck passed; npm run test:orchestrator passed 11/11 after rerunning unsandboxed for the known Windows .tmp write restriction.

## Phase F Step 0 Checkpoint: one active turn per session (2026-07-10, build)

Built the Phase E carry-over before starting Phase F features. This is localhost-only work; no hosting, deploy config, production URL, manifest URL, or Vercel change was made.

Implemented server-side one-turn-per-session locking:
- Added supabase/2026_v2_phase_f.sql with agent_sessions.turn_active_until and an index for active locks.
- Added lib/agent/turn-lock.ts with pure turnActiveUntil and turnClaimDecision helpers. The self-healing lock window is current turn timeout plus the max approval wait.
- POST /api/agent/sessions/[id]/messages now claims the session with a guarded update before streaming. If an unexpired turn is active it returns 409 and does not start a second loop.
- The lock is cleared in finally after runAgentTurn exits. If the server crashes, the timestamp expiry lets a later request reclaim the session.
- The Stop button is labeled as "Stop watching; the agent finishes in the background" so client abort behavior is honest.

Verification for this step: npm run typecheck passed; npm run test:orchestrator passed 9/9 after rerunning unsandboxed for the known Windows .tmp write restriction.

## Phase F Step 1 Checkpoint: teach mode toggle and banner (2026-07-10, build)

Implemented the first Phase F feature step after committing Step 0:
- Extended supabase/2026_v2_phase_f.sql with agent_sessions.teach_mode boolean not null default false.
- Session list/detail/create payloads now include teach_mode.
- Added PATCH /api/agent/sessions/[id] for owner-only teach_mode toggling. Archived sessions cannot be toggled.
- /agent now hydrates teach_mode and AgentChat shows a "Teach a workflow" toolbar button plus a visible banner when teach mode is active.

No UI workflow tools execute in this step. Server-side ui_step gating comes in Step 2.

Verification for this step: npm run typecheck passed.

## Phase F Step 2 Checkpoint: ui_step executor gated by teach mode (2026-07-10, build)

Implemented the first UI execution surface, limited to guided teach mode:
- Added lib/agent/ui-tools.ts with the UI step vocabulary and Zod validation for open_url, wait_for, click, fill_field, read_field, press_key, confirm_text_present, verify_field, and screenshot.
- Added ui_step to the agent tool definitions with tier 2 display, but it is not a CRM write tool and does not alter the Phase D write gate.
- runAgentTurn checks agent_sessions.teach_mode immediately before queueing ui_step. If teach mode is off, the call becomes an error observation and no extension job is inserted.
- Added extension/src/page-runner-ui.ts as a MAIN-world, self-contained runner for one UI step per call.
- extension/src/jobs.ts routes ui_step jobs, enforces crm.zoho.com for open_url before dispatch, and handles screenshot in the background with a 500 KB cap.
- Added the activeTab permission and local chrome.d.ts entries for tab update, tab completion, and screenshot capture.
- Added pure tests for ui_step schema and teach-mode gate.

Verification for this step: npm run typecheck passed; npm run test:orchestrator passed 10/10 after rerunning unsandboxed for the known Windows .tmp write restriction; npm run build:extension passed after rerunning unsandboxed for the known extension/dist write restriction.

## Phase E review (2026-07-09, chat review)

Verdict: approved with ONE required follow-up before the Phase E done gate; no slop found. Verified independently from the committed tree (git archive of 15bb0c9 into /tmp; the mount served NUL-padded stale working-tree copies, so the object store was the review source): tsc --noEmit clean; tier2 14/14, orchestrator 8/8, records 5/5 - matching the build log's claims exactly. Grep-proofs re-run and hold: page-runner-write.ts is still the only CRM PUT/actions path; still exactly two tool_jobs INSERT sites, both calling assertTier2JobInsertAllowed; claim-route approval check intact; purge is reachable ONLY from the admin button behind window.confirm, never on load.

Spec conformance checked item by item: Phase D backlog (a) PUT rows matched by row.details.id with positional fallback removed, (b) partial per-record results now carried in write_failed/verify_failed payloads (report route stores them), (c) WRITE_TOOLS/TIER2_WRITE_TOOL_NAMES sync enforced by a source-parsing unit test. Per-cycle handshake dropped (claim's requireExtensionAuth refreshes last_seen_at - confirmed in lib/extension/auth.ts). Extension-side zoho_read_api allowlist re-check present in page-runner.ts. Sweeps extracted to pure lib/agent/sweeps.ts with tests; session load sweeps stale approvals AND stale queued jobs. Env budgets via lib/agent/runtime-config.ts with defaults preserving current behavior; .env.example documented. /admin/agent-activity admin-guarded (requirePageRole redirects); nav hides all /admin for non-admins. /agent is root + post-login landing; /run/new demoted, route kept. module-map.json unification is real and behavior-preserving (parsing stays shape-specific by design, documented). Options page job history capped at 10. Docs (user guide, test checklist) honest and complete; checklist encodes the rendered-UI lesson.

REQUIRED FOLLOW-UP (before Phase E done-when): enforce spec section 8.6 "one active agent turn per session" server-side. There has never been a hard guard, and the new Stop button makes the race easy to hit: it aborts only the client fetch (the server turn keeps running - the code comment is honest about this), re-enables the composer immediately, and a resent message starts a SECOND concurrent turn in the same session. Two loops then interleave agent_messages rows and can each raise Tier-2 approval cards. call_id pairing keeps transcripts structurally valid, but ordering/confusion risk is real and the guardrail is binding. Suggested design for Codex: add agent_sessions.turn_active_until (timestamptz, null when idle); messages POST does a guarded update claiming the turn (set now + turn budget + max approval wait when null or expired, 409 otherwise); loop clears it in a finally block; expiry makes crashed turns self-healing. Also label the Stop button's behavior in the UI ("stops watching; the agent finishes in the background").

Minor, non-blocking: /admin/agent-activity isFailure() is a heuristic (metadata.ok/status + message regex) - fine for an admin glance, revisit if it feeds anything automated. Options-page handshake now also writes a history entry, duplicating jobs.ts entries in the same list - cosmetic.

Process note: HANDOFF (build-updated) states Phase D is live-accepted. The chat has only seen the scenario-3 happy path confirmed; Aryan should confirm the remaining Phase D live paths (reject, identity-mismatch, verify-failure, logged-out, negative proofs) were actually run, or run them as part of the Phase E checklist's Phase D section, which covers them all.

## Phase E Checkpoint: Hardening backlog burn-down (2026-07-09, build)

Started Phase E from workflows/SPEC_v2_phase_e_hardening.md v1.1 after the Phase D live-acceptance note. Scope remains hardening only; no new agent tool surface.

Closed review backlog items in build order:
- Bridge liveness remains at the Phase B hotfix value of 120s and is now env-tunable through EXTENSION_LIVE_MS without changing the default.
- Removed the per-cycle extension handshake from extension/src/jobs.ts; /api/ext/jobs/claim already refreshes last_seen_at through requireExtensionAuth.
- Added extension-side zoho_read_api GET allowlist re-check in page-runner.ts as defense in depth.
- Extracted approval/job sweep constants and patches into lib/agent/sweeps.ts with pure tests added to the orchestrator test target.
- Moved shared Accounts/Contacts/Deals table, id, URL tab, compare-column, and CSV-column metadata into lib/records/module-map.json, used by both live upsert and the CSV master import script. Shape-specific parsing stays separate because live Zoho rows and cleaned CSV rows are different input contracts.
- Fixed page-runner-write.ts PUT response handling to match rows by row.details.id instead of array position.
- Failed write/verify responses now carry partial per-record results in the failure payload so reports can show records already read, skipped, written, or verified before the abort.
- Added a test-time assertion that extension/src/jobs.ts WRITE_TOOLS matches lib/agent/tier2-tools.ts TIER2_WRITE_TOOL_NAMES.

Sweeps and rollout hardening in progress:
- Session load now sweeps both stale pending approvals (>15 min) and stale queued tool_jobs (>10 min), matching claim-time behavior.
- AGENT_MAX_TOOL_CALLS, AGENT_TURN_TIMEOUT_MS, AGENT_JOB_TIMEOUT_MS, CODEX_RESPONSES_URL, and LLM_MODEL are env-tunable. Defaults preserve existing behavior: 15 tool calls, 180000ms turn budget, 90000ms job wait, Codex Responses URL https://chatgpt.com/backend-api/codex/responses, Codex model gpt-5.4, OpenAI API-key model gpt-4.1-mini.
- Added /admin/agent-activity with admin page guard, filtered audit activity, per-user counts, latest failures, and a confirmed admin-only purge for archived agent_sessions older than 30 days. Purge is never automatic.
- /agent is now the root and post-login landing page. /run/new remains routable but is removed from primary nav.
- Extension options now stores and renders the last 10 agent job status messages.

## Phase E Checkpoint: Automated verification before chat review (2026-07-09, build)

Automated verification passed on the Windows workspace:
- npm run typecheck
- npm run lint
- npm run build (passes; Next still warns that middleware file convention is deprecated in favor of proxy)
- npm run build:extension
- npm run test:orchestrator: 8/8
- npm run test:records: 5/5
- npm run test:tier2: 14/14

Sandbox note: the first test/build attempts hit the known Windows EPERM artifact-write issue under .tmp, .next, and extension/dist. Rerunning the same commands unsandboxed passed.

Docs added/updated:
- zoho-agent/docs/V2_USER_GUIDE.md
- zoho-agent/docs/V2_TEST_CHECKLIST.md
- HANDOFF.md
- ZOHO_AGENT_WORK_PLAN.md
- zoho-agent/README.md
- zoho-agent/.env.example

Not declaring Phase E done yet. Per the spec, stop for chat review first; final done-when still requires the rendered/manual checklist in zoho-agent/docs/V2_TEST_CHECKLIST.md, including the browser-click approval-card approve/reject tests and Aryan's one full day of real usage with zero unexplained failures.

## Agent instructions: direct record links (2026-07-09, chat)

Live testing (post-write): asked for a direct deal link, the agent said it lacked a tool and offered request_new_tool. Wrong - the URL is deterministic (https://crm.zoho.com/crm/org890324941/tab/{Potentials|Contacts|Accounts}/{zoho_id}, Deals = Potentials in URLs) and mirror rows already carry zoho_url. Instruction-only fix in lib/agent/loop.ts AGENT_INSTRUCTIONS: prefer zoho_url from db_get_record/db_search_records, else compose the canonical URL; never claim links need a new tool. tsc clean. Restart the dev server to pick up the new instructions; no extension rebuild. The stray tool_requests row from this exchange can be closed in Supabase if one was filed.

## Phase D live-test defect fix: approval card buttons were dead (2026-07-09, chat)

Symptom (Aryan, first live scenario-3 attempt): the approval card rendered correctly (record, Next_Step before/after) but Approve/Reject could not be clicked.

Root cause (components/agent-chat.tsx): the card was rendered with disabled={loading}, and `loading` stays true for the entire agent turn - but the turn is BLOCKED waiting for this very decision. The card was therefore always disabled exactly when it mattered: a UI deadlock (turn waits for user, user waits for turn) that only resolved by the 15-min expiry. Missed by build and review because both tested the flow via manual DB flips, never through the rendered button.

Fix: the card is no longer gated on the turn-level `loading` flag; it has its own per-card `deciding` guard against double clicks (the buttons also unmount on the optimistic status flip, and the server 409s any second decision - the atomic pending-guard, so this was never a safety issue, purely a usability deadlock).

Verified: tsc --noEmit clean on the /tmp copy. Client component only - refresh the browser (dev mode hot-reloads; production needs npm run build + restart). No extension or DB change.

## Phase D review (2026-07-09, chat review)

Verdict: approved pending live acceptance. One real defect and one hardening gap fixed by the reviewer; spec-conformant otherwise. Verified independently in the sandbox (/tmp copy): tsc --noEmit clean project-wide; tier2 tests 13/13 (12 build + 1 reviewer-added), orchestrator 7/7, records 5/5. Grep-proofs re-run and hold: page-runner-write.ts is the ONLY CRM PUT/actions path (page-runner.ts stays GET-only; api.ts POSTs are backend-only); exactly two tool_jobs insert sites, both calling assertTier2JobInsertAllowed (bridge passes null so a Tier-2 name throws; approvals route is the sole Tier-2 job creator and passes approval_id); claim route refuses/terminally-fails Tier-2 jobs whose approval is not approved; extension refuses write jobs lacking approval_id. Approval flip is atomic (status='pending' guard), owner-only, decision snapshot (decided.args) is exactly what is enqueued and executed. Budget pause (pausedMs) correct. error_code round-trip (identity_mismatch, zoho_logged_out, verify_failed) preserved through the report route.

Defect fixed (lib/agent/tier2.ts waitForApprovalOutcome): expiry race. If the user decided in the gap between the loop's last 1s poll and the 15-min expiry flip, the guarded expire update matched zero rows but the function still returned "expired" - while the approvals route had already enqueued the write job, so the write would execute while the chat claimed it expired. Now: when the guarded expire matches zero rows, re-read the row and honor a late approved/rejected decision. Safety was never at risk (the write was genuinely user-approved); the defect was dishonest state reporting.

Hardening fixed (lib/agent/tier2-tools.ts validateUpdateFields): lookup-typed fields were settable through zoho_update_fields with a raw string id - only object/array VALUES were rejected, so Owner (data_type ownerlookup) as a plain id string slipped past, bypassing zoho_change_owner's name resolution and producing a card showing a bare id plus a broken read-back compare (object vs string). Any field whose data_type contains "lookup" is now rejected at validation with a pointer to zoho_change_owner for Owner. Unit test added (13th).

Non-blocking (Phase E backlog): (1) page-runner-write pass-2 matches PUT response rows to request rows positionally (rows[i] vs group[i]); Zoho preserves order in practice, but match on row.details.id for safety. (2) On write_failed/verify_failed mid-batch the collected per-record results are discarded from the failure payload; include partial before/after so the report shows what DID change before the abort. (3) jobs.ts duplicates the write-tool name set from tier2-tools.ts (documented; extension cannot import lib/) - acceptable, keep in sync.

NOTE (sandbox process): the mount briefly served a stale truncated copy of this file mid-review; the host file was intact. Force a rename round-trip before trusting the mount's view of freshly written files.

Before live testing: run supabase/2026_phase_d_writes.sql in Supabase FIRST (adds tool_jobs.approval_id; waitForApprovalJob and the claim route depend on it), then npm run lint && npm run build && npm run build:extension on the dev machine, reload the unpacked extension, restart the dev server. Live acceptance owed: scenario 3 approve/reject/identity-mismatch/verify-failure/logged-out paths + the three negative proofs from spec section 5.5.

## Phase D Checkpoint: Approval-Gated Zoho Writes (2026-07-09, build)

Built the full Tier-2 write path per workflows/SPEC_v2_phase_d_gated_writes.md. Nothing writes to Zoho without a pending_approvals row flipped to approved by the session's own user, enforced server-side and grep-provable.

Stage 1 - tools + validation. lib/agent/tier2-tools.ts adds zoho_update_fields, zoho_change_owner, zoho_add_tags, zoho_remove_tags (all tier 2). validateTier2Call is pure: it checks field existence against zoho_field_meta, picklist membership, email format, and date shape; blocks Deal_Name for everyone; makes Stage admin-only; resolves owner_name against KNOWN_OWNERS; dedupes ids/tags. Rule logic was EXTRACTED from lib/plan/validation.ts into lib/plan/field-rules.ts and both callers now import it (no reimplementation). Validation runs BEFORE any approval card, so an invalid call becomes a model observation and never reaches the user. Tool JSON schemas omit unused keys (additionalProperties:false, no empty strings) per the Phase B/C lesson.

Stage 2 - approval flow. lib/agent/tier2.ts builds the per-record before/after summary (mirror first; live zoho_get_record via the Phase B bridge for <=10 missing records; else "unknown - verify in card") and freezes an immutable snapshot carrying an expected_name per record for the identity check. createPendingApproval inserts the row. The loop (lib/agent/loop.ts) validates -> builds -> inserts -> emits SSE approval_required -> waits (poll 1s, max 15 min) with the turn budget CLOCK PAUSED during the wait (pausedMs subtracted). POST /api/agent/approvals/[id] is session-authed, owner-only, does an atomic status-guarded flip (pending -> approved|rejected), audits approval_decided, and on approve enqueues exactly one tool_jobs row carrying approval_id. Chat UI (components/agent-chat.tsx) renders an approval card (per-record name/field/before->after table, Approve/Reject) and rebuilds card state from pending_approvals on load (reconnect-safe).

Stage 3 - expiry. Wait timeout flips the row to expired with a guarded update (waitForApprovalOutcome). Session GET sweeps pending approvals older than 15 min to expired (service-role, owner-scoped) before returning them, so a stale card can never be approved into a write.

Stage 4 - execution. extension/src/page-runner-write.ts is a self-contained MAIN-world runner (the ONLY PUT/actions path). Per record: GET current, identity check (record name must match the approved expected_name or the whole job aborts with identity_mismatch), skip-if-already-equal (idempotent resume), PUT /crm/v2.2 chunked <=100 requiring per-record code SUCCESS (owner via Owner:{id}, tags via actions/add_tags|remove_tags), then read-back VERIFY before verified:true; logged-out -> zoho_logged_out abort; 30s per call, 120s job cap. extension/src/jobs.ts routes write tool names to this runner ONLY when approval_id is present, else reports "write without approval refused by extension".

Belt-and-braces approval gate (3 enforced points, all with a pure unit-tested helper in tier2-tools.ts): (1) assertTier2JobInsertAllowed at every tool_jobs insert site - the bridge (tier-1 only) passes null and would throw for a write; the approvals route passes approval_id. (2) the ext claim route calls tier2ClaimDecision and hands out a Tier-2 job only when its linked approval is approved, else terminally fails the job. (3) the extension refuses any write job lacking approval_id. DB migration supabase/2026_phase_d_writes.sql adds tool_jobs.approval_id (FK to pending_approvals) + indexes; pending_approvals/tool_jobs remain service-role-write only.

Verified in the Linux sandbox against a NUL-stripped mirror (the host<->sandbox mount serves stale/padded copies of fresh writes; a filename rename round-trip forces a refresh): `tsc --noEmit` clean across the whole project incl. extension entrypoints; new unit tests 12/12 (validation rules, Stage/Deal_Name/picklist/email/date, owner resolution, and the three approval-gate guards as negative proofs). NOT yet run here (must run on the dev machine): npm run lint, npm run build, npm run build:extension (win32 esbuild), and the live scenario-3 acceptance (approve, reject, identity-mismatch via mid-flight edit, verify-failure, logged-out) plus the live negative proofs (manual Tier-2 job without approval_id -> claim refuses; approval by a different user -> 403; expired approval -> job never created). This phase was built in one pass by the reviewer agent at Aryan's direction, so it has NOT had an independent review of the approval gate - that review is still owed before Phase D is declared done.

## Phase C live acceptance PASSED (2026-07-09, Aryan)

Scenario-2 sync test complete: fresh tag on demo accounts -> agent pulled them via zoho_search -> db_sync_records upserted -> Records browser shows rows -> re-run reported all unchanged. Phase C is closed. Phase D (gated writes) build authorized per workflows/SPEC_v2_phase_d_gated_writes.md.

## Agent search resolution: interpret loose wording, fall back before giving up (2026-07-08, chat)

Follow-on from the zoho_search fix below, same live session. Aryan asked for "the deal with the tag test search"; the agent searched the literal tag "test search", got zero results, and stopped - the real tag was "test". The tool worked once fixed; the gap was in the agent's instructions, which never told it to treat the user's wording as approximate intent or to do anything after an empty search besides report "not found".

Fix (lib/agent/loop.ts AGENT_INSTRUCTIONS only - no code or tool-surface change): added two directives. (1) Treat wording as intent, not exact values - a phrase like "the tag test search" may mean the tag is "test", or a name/field match; infer and try. (2) On an empty search, do not stop after one attempt: retry with broader/alternative terms or a different approach (tag vs name vs criteria), use db_list_tags / db_list_by_tag / db_search_records to discover what actually exists and pick the closest, and only then, if still no confident match, say what was tried and offer closest candidates or ask one short question. Stays within the existing tool-call budget.

Verified: npx tsc --noEmit clean. Same deploy note as the fix below - restart the server so the new instructions take effect; no extension rebuild.

NOTE (process): both edits to this file and to loop.ts were first attempted with the inline edit tool, which truncated the files on writes containing non-ASCII characters (em-dashes, arrows, ellipsis). Recovered from git and rewritten as ASCII via script. Prefer ASCII in these files.

## Phase B defect fix: zoho_search rejected valid tag-only lookups (2026-07-08, chat)

Symptom (Aryan, live): "find the deal tagged test search" → `zoho_search` failed validation repeatedly, alternating between two errors — `criteria`/`name` "Too small: expected string to have >=1 characters", and "zoho_search requires exactly one of criteria, name, or tag." The agent correctly refused to improvise and filed tool request `zoho_search_optional_fields_fix` (`daa578fe-…`).

Root cause (two, in `lib/agent/tier1-tools.ts`):
1. The JSON schema exposed to the model had `criteria`/`name`/`tag` as three bare `{type:"string"}` fields with no descriptions and no expression of the "exactly one of" rule, so the model couldn't discover the correct shape. A clean `{module, tag}` call DID pass — the model just never produced one.
2. The Zod schema hard-failed on empty strings (`.trim().min(1)`), so the model's common habit of sending `""` for unused fields tripped `min(1)` (error shape 1); swinging to zero/two provided fields tripped the refine (error shape 2). This is the same "omit unused keys, never send empty strings" lesson from Phase 2 that hadn't been applied to the Tier-1 schema.

Fix: `criteria`/`name`/`tag` now go through an `optionalSearchTerm` preprocess that maps empty/whitespace-only strings to `undefined` (so they count as omitted, not invalid); the refine message now tells the model to provide one and omit the others; and the tool description + each field's JSON-schema `description` now state the one-of rule and how to search by tag. No behavior change for valid calls; invalid calls get one clear, actionable error instead of two confusing ones.

Verified: `npx tsc --noEmit` clean. Still needs on the dev machine: `npm run lint && npm run build`, then redeploy/restart so the running `/agent` picks up the new tool schema (the model only sees the change after the server reloads). No extension rebuild needed (server-side only). Tool request `zoho_search_optional_fields_fix` can be closed once confirmed live. Suggested follow-up: a unit test asserting `{module,tag}` parses and `{module,criteria:"",name:"",tag:"x"}` normalizes to a tag-only search.

## Phase C review (2026-07-08, chat review)

Verdict: approved, one defect fixed. Verified independently: tsc clean, records tests 5/5 + orchestrator 7/7, spec-conformant (in-process db_sync_records; Zod before service client; FK resolution with warnings; stable-stringify change detection incl. raw_data; 200-cap; capped-names result; `mirror_sync` audit; CSV-mapper divergence documented; pagination guidance in prompt; still zero Zoho writes).

Defect fixed (`lib/records/zoho-upsert.ts`): duplicate zoho ids within one batch (possible via paginated zoho_search overlap) hit Postgres "ON CONFLICT DO UPDATE command cannot affect row a second time" and failed the whole sync. Records now deduped by id (keep last) with a warning; invalid id-less rows still reach assertRecord for a clear error.

Remaining before Phase D: Aryan runs the live scenario-2 test (fresh tag on 2–3 demo accounts → sync → re-run shows all-unchanged).

Confirmed on 2026-07-06.

1. V2 primary UX is a server-side tool-calling chat agent. The Phase 2 parse/validate/run pipeline remains for batch preset workflows.
2. Phase A is limited to the agent core and Tier-0 local database tools. It must make no Zoho calls and no CRM writes.
3. The Phase 3 extension bridge remains the execution model for later Zoho tools. The extension stays a dumb executor; agent logic stays on the server.
4. The migration is additive and idempotent. It creates the full v2 table set early (`agent_sessions`, `agent_messages`, `tool_jobs`, `pending_approvals`, `tool_requests`, and `ui_workflows`) so later phases do not need destructive schema changes.
5. `tool_jobs` and `pending_approvals` are readable by their owning user through RLS, but writes are reserved for server routes using the service-role client after explicit session/role checks.

## Phase A Start

The binding engineering invariants from Phase 2 and Phase 3 carry forward:

- API routes return JSON errors with tagged server logs.
- Upstream LLM fetches must have explicit timeouts.
- Configuration checks fail before side-effecting upstream calls.
- Client fetch handlers must clean up loading state.
- Unknown model tool names are never executed; they become tool error observations fed back to the model.
- Agent turns have budgets: max 15 tool calls and max 3 minutes wall clock.

External references checked before implementation:

- `earendil-works/pi` `openai-codex-responses.ts`: Codex Responses streams tool calls through output-item and function-call-arguments SSE events.
- `vercel-labs/open-agents`: keep the agent outside the executor and persist the turn transcript so execution can become durable in later phases.

## Phase A Checkpoint: Tier-0 Tools + Provider Tool Calls

Extracted shared local-mirror search code into `lib/records/mirror.ts` so Phase 2 preview resolution and the new agent DB tools use the same exact matching order: exact -> starts_with -> contains -> token match, with deal account-name search included.

Added Tier-0 tool definitions/execution in `lib/agent/tier0-tools.ts`: `db_search_records`, `db_get_record`, `db_list_by_tag`, `db_list_tags`, `db_query`, and `request_new_tool`. Tool args are Zod-validated before execution, `db_query` accepts structured filters only, and all data comes from the user-scoped Supabase client so RLS applies.

Extended `LLMProvider` with `runTools()`. The OpenAI API-key provider uses standard Responses function tools with a 90s timeout. The Codex provider keeps the known header/body quirks and now extracts function calls from both `response.completed` output and streamed `response.function_call_arguments.*` events.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.

## Phase B Checkpoint: Extension Job Claim/Report Routes

Added the read-tool job bridge routes under `/api/ext/jobs/*`. `POST /api/ext/jobs/claim` uses the existing extension bearer-token auth, sweeps this user's stale queued/running jobs, then claims the oldest queued job with a guarded `status='queued'` update so concurrent polls lose cleanly. `POST /api/ext/jobs/[id]/report` only finalizes the claiming user's `running` job, stores `done`/`failed`, preserves `zoho_logged_out` as an error code in the result payload, and audits `ext_job_reported`.

Extended `/api/ext/handshake` with `queued_jobs` so the extension options UI can show pending agent jobs. No schema change was required because `tool_jobs` already exists in the V2 migration.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass. Manual curl/database claim testing still needs a real `tool_jobs` row in Supabase.

## Phase A Review Gate

Implementation is complete and committed through the `/agent` chat surface. Verification on 2026-07-06:

- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm run build` passes after rerunning outside the sandbox because `.next/trace-build` hit a Windows `EPERM` in the sandbox.
- `npm run test:orchestrator` passes 7/7 after rerunning outside the sandbox because `.tmp/orchestrator-test` writes hit the same sandbox `EPERM`.
- `npm run build:extension` passes after rerunning outside the sandbox because the build needed to unlink existing ignored `extension/dist` files.

Manual acceptance still requires Aryan to run `supabase/2026_v2_agent.sql` in Supabase, then test `/agent` against the real mirror:

1. "Get me the next step for the Duraco deal" should use `db_search_records` / `db_get_record` and answer from the local mirror, labeled as of last sync.
2. "Merge these duplicate accounts" should not improvise; it should call `request_new_tool` and create a `tool_requests` row.

Stop here for review before Phase B. No Zoho calls or CRM writes exist in Phase A.

## Phase A Checkpoint: Agent Routes + Chat UI

Added the Phase A server loop in `lib/agent/loop.ts`: it persists the user message, calls the user's existing LLM credential through `runTools()`, executes only Tier-0 tools, persists assistant/tool messages, emits SSE events, and audits `agent_turn` / `tool_call`. The loop enforces the Phase A budgets: max 15 tool calls and 3 minutes wall clock.

Added `/api/agent/sessions`, `/api/agent/sessions/[id]`, and `/api/agent/sessions/[id]/messages`. Message POST streams typed SSE events: `assistant_delta`, `tool_call`, `tool_result`, `done`, and `error`. Routes use the existing server auth guard and user-scoped Supabase client so RLS applies.

Added `/agent` with a session list, chat pane, streaming assistant messages, and visible Tier-0 tool trace rows. Added the Agent nav item and protected `/agent` in middleware. Phase A UI explicitly labels responses as local DB-only; no Zoho tools are available yet.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.

## Phase A review (2026-07-06, chat review)

Verdict: high quality, spec-conformant, approved with two small fixes applied by the reviewer. Verified independently: committed tree typechecks clean, orchestrator tests 7/7, migration SQL matches the spec with proper role-checked RLS, `db_query` is structured-only, tool args double-validated (JSON Schema + Zod), unknown tools error back to the model, budgets enforced, mirror refactor leaves a single shared matching implementation used by both the run pipeline and the agent. Docs honest and complete — no slop found.

Fixes applied:
1. `app/api/agent/sessions/[id]/messages/route.ts` — session lookup now enforces ownership explicitly (`user_id === auth.user.id`) and rejects archived sessions. RLS let admins READ any session, so an admin posting into another user's chat would have started a turn that died mid-way on the message-insert policy.
2. `lib/agent/loop.ts` — transcript rebuild now skips assistant tool-call marker rows (tool_name set, no content); they exist for UI trace/audit but replayed as empty assistant messages in the prompt.

Noted as a KNOWN Phase A limitation (fix scheduled first in Phase B): the transcript is flattened to one text block per model call (`composeAgentInput`) instead of item-based `function_call`/`function_call_output` pairing. Fine for Phase A's single-tier loop; must be upgraded before multi-step Zoho tool chains.

Next: `workflows/SPEC_v2_phase_b_extension_bridge.md` — extension job bridge + live Zoho reads (GET-only), transcript upgrade first.
## Phase B Checkpoint: Item-Based Tool Transcript

Started Phase B with the transcript upgrade required before multi-step live Zoho tools. Both LLM providers now send item-based Responses input by default: text messages, assistant `function_call` items, and paired `function_call_output` items. `AGENT_FLAT_TRANSCRIPT=1` remains as a one-release fallback.

Call IDs are persisted inside `agent_messages.tool_args._call_id` instead of adding a column. This keeps already-run V2 migrations compatible while preserving the required call_id round-trip for new tool calls. Legacy tool rows without `_call_id` are replayed as plain text fallback context rather than dropped.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.
## Phase B live-read timeout debug (2026-07-07, chat)

Symptom: mirror search fine, Tier-1 job queued, backend expires with "Timed out waiting for the Chrome extension to report this job" — extension never reported.

Diagnosis (two stacked causes):
1. **Job silently never claimed when no crm.zoho.com tab matched.** `jobs.ts pollOnce()` returned BEFORE claiming when `tabs.query` found no CRM tab, while the 1-minute run-items poll kept `last_seen_at` fresh — so the backend preflight passed, the job sat `queued`, and the user got the generic 90s timeout. This exactly matches the reported symptom.
2. **The fe7cca2 page-context executor could never run on Zoho anyway.** It injected an inline `<script>` element; Zoho CRM's page CSP blocks inline scripts, so `pageRunner` would never execute and every claimed job would burn the 20s content timeout and report a useless "page-context executor" error.

Fixes:
- `extension/src/jobs.ts` — tab lookup moved AFTER claim; missing tab now reports `failed` immediately with "No crm.zoho.com tab is open…" (actionable chat feedback in seconds, not a 90s timeout). Step-level `saveLastJobStatus` breadcrumbs added: connected → claimed → running-in-tab → completed/failed.
- **Executor switched to `chrome.scripting.executeScript({ world: "MAIN" })`** driven from the background worker — CSP-immune, and the promise resolves with the runner's return value so the postMessage plumbing is gone. New self-contained `extension/src/page-runner.ts` (GET-only, same header/fallback/logged-out logic; MUST stay closure-free — it is serialized into the page). `content.ts` reduced to the ping listener. `manifest.json` adds the `scripting` permission (answers: yes executeScript, yes scripting permission).
- `lib/agent/bridge.ts` — timeout errors now distinguish "never picked up" (check toggle + CRM tab) from "picked up but never reported" (refresh the tab).

Verified: `npx tsc --noEmit` clean. `npm run build:extension` must run on the dev machine (esbuild binary is win32 in node_modules). After rebuilding, RELOAD the unpacked extension; content-script changes also need a crm.zoho.com tab refresh.

## Phase B review (2026-07-07, chat review)

Verdict: approved, one real defect fixed, no blocking issues. Independently verified: committed tree typechecks clean; extension executor is grep-provably GET-only (single fetch path, `method: "GET"`, only 4 read functions mapped); claim is atomic (status-guarded update + lost_race); sweeps correct and same-user scoped; report finalizes only the owner's `running` job; bridge fails before side effects on offline extension, expires timed-out jobs with a guarded update, and maps `zoho_logged_out` to user guidance; tier-1 args are Zod-validated + field-checked BEFORE queueing; `zoho_read_api` allowlist is anchored and GET-only; item-based transcript pairs `function_call`/`function_call_output` by `call_id`, `_call_id` persistence is backward-compatible, legacy tool rows fall back to text, `AGENT_FLAT_TRANSCRIPT=1` path intact; chat handles `tool_status` keyed by call_id.

Defect fixed (extension/src/background.ts): the job poller was a `setTimeout` chain started at worker startup — MV3 terminates idle service workers (~30s), killing the chain; job pickup could stall indefinitely until an unrelated wake. The existing 1-minute alarm now also fires `pollAgentJobOnce()`, bounding worst-case pickup latency to the alarm period (worker wake re-runs `startJobPolling` for the fast loop).

Non-blocking recommendations (Phase C backlog):
1. `lib/agent/bridge.ts` EXTENSION_LIVE_MS=60s can spuriously report "extension not connected" during a worker-teardown gap; consider 120s.
2. `extension/src/jobs.ts` calls handshake+claim every 1.5s cycle; claim alone updates last_seen — drop the per-cycle handshake to halve request volume.
3. `extension/src/zoho-api.ts` `rawGet` trusts server-validated paths; add the same allowlist check extension-side as defense-in-depth.
4. Missing tests: none for jobs claim/report atomicity or bridge timeout paths — add route-level tests when a test harness for Next routes lands (orchestrator-style pure-function extraction would work: move sweep/claim decisions into lib functions).

## Phase B Checkpoint: Server Bridge Wait Loop

Added `lib/agent/bridge.ts` for Tier-1 extension-backed tools. It fails before side effects if the user's extension has not handshaken within 60 seconds, enqueues one `tool_jobs` row, emits queued/running status updates, polls every 500ms, expires timed-out jobs, and converts `zoho_logged_out` failures into direct user guidance.

Wired the agent loop so Tier-1 tool calls use the bridge while Tier-0 tools still run in-process. The chat UI now understands `tool_status` SSE events and labels the agent surface as Phase B read-only bridge work.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass. Fake-job done/failed testing still needs a Supabase row or the extension executor from the next checkpoint.
## Phase B Checkpoint: Tier-1 Live Read Tool Definitions

Added Tier-1 tool definitions for `zoho_search`, `zoho_get_record`, `zoho_get_related`, and `zoho_read_api`. Args are Zod-validated server-side before queueing. `zoho_search` requires exactly one of `criteria`, `name`, or `tag`; `zoho_read_api` is GET-only via anchored allowlist regexes; params are capped at eight keys.

`zoho_get_record` validates requested field API names against `zoho_field_meta` before a job is inserted. The loop now exposes Tier-0 plus Tier-1 tools to the model, routes Tier-1 calls through the extension bridge, and keeps the agent instructions honest about mirror vs live sources and the Phase B no-write boundary.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.
## Phase B Checkpoint: Extension GET Job Executor

Finished the Phase B extension executor for read-only agent jobs. Added a GET-only Zoho session API helper, content-script execution for `zoho_search`, `zoho_get_record`, `zoho_get_related`, and `zoho_read_api`, and a separate background `jobs.ts` poller that claims one agent job at a time only when the extension is enabled and a `crm.zoho.com` tab exists. The old Phase 3 dry run-item polling path remains separate.

The options page now shows queued agent jobs from handshake plus a last-job status line, and the enable toggle is labeled as read-only Zoho session access. Logged-out Zoho detection reports `zoho_logged_out` back to the server.

Verified after this checkpoint: `npm run typecheck`, `npm run lint`, and `npm run build:extension` pass. GET-only proof: `jobs.ts`/`zoho-api.ts` contain one CRM fetch path and it uses `method: "GET"`; no PUT/POST/PATCH/DELETE CRM path exists in the Phase B executor.
## Phase B Verification Gate

Automated verification passed after the extension executor checkpoint: `npm run typecheck`, `npm run lint`, `npm run build`, `npm run build:extension`, and `npm run test:orchestrator` (7/7). The production build still emits Next's middleware-to-proxy deprecation warning, but it completes successfully.

Manual live acceptance remains: reload the unpacked extension, keep the toggle enabled with a logged-in `crm.zoho.com` tab, then ask `/agent` "Get me the next step for the Duraco deal." Expected trace: mirror search first, then live `zoho_get_record`, final answer labeled live. Negative paths to spot-check manually: extension disabled/offline, non-allowlisted `zoho_read_api`, Zoho logged out, and a timed-out job.
## Phase B Runtime Test Fix: Extension Backend Errors

During extension testing, Chrome surfaced stack traces at `extension/src/api.ts` instead of a useful root cause when the backend fetch failed or returned a non-OK response. `appFetch` now reports the concrete URL plus timeout/backend/host-permission guidance, the alarm-triggered dry poll catches failures instead of surfacing uncaught promise errors, and the manifest includes `http://127.0.0.1:3000/*` alongside `localhost`.

Verified after this fix: `npm run typecheck`, `npm run lint`, and `npm run build:extension` pass.

Follow-up from first live-read attempt: mirror search worked, but `zoho_get_record` failed preflight with "Chrome extension is not connected." The server liveness window is now 120s instead of 60s so MV3's 1-minute alarm wake plus normal jitter does not falsely mark a recently handshaking extension offline.

HeySnap session-API reference confirmed the Zoho fetch must run in the actual `crm.zoho.com` page context, not the extension service worker. The content script now injects a one-shot page-context runner for `zoho_search`, `zoho_get_record`, `zoho_get_related`, and `zoho_read_api`; the page runner reads `#token`, sends `X-ZCSRF-TOKEN: crmcsrfparam=<token>`, `X-CRM-ORG: 890324941`, `X-Requested-With`, `credentials: "include"`, and posts the JSON/error result back to the content script for reporting.

## Phase C Checkpoint: Live Zoho to Mirror Sync

Added `lib/records/zoho-upsert.ts` for live Zoho API rows. It intentionally stays separate from `scripts/import-masters.mjs` because CSV exports and live API payloads use different shapes; field-map unification remains a Phase E hardening item. The mapper preserves the full live record in `raw_data`, composes canonical Zoho URLs, resolves contact/deal account/contact FKs from existing mirror rows, warns on unresolved lookups, and classifies each row as inserted, updated, or unchanged before upserting only changed rows.

Added `db_sync_records` as a Tier-1 in-process tool. The model must pass `{ module, records }` with 1-200 live Zoho records that each have a string `id`; Zod validation happens before the service client upsert. The tool audits `mirror_sync` with counts and returns capped inserted/updated names plus warnings. Existing Zoho read tools still go through the extension bridge; this local DB sync never writes to Zoho.

Agent instructions now tell the model to use `zoho_search` for tag-driven pulls, paginate until `more_records=false`, then call `db_sync_records` only for the records the user asked to sync. The Agent UI label now reflects Phase C.

Verified after this checkpoint: `npm run typecheck`, `npm run lint`, and `npm run test:records` pass. Live acceptance still needs Aryan to create/tag 2-3 demo records in Zoho, ask the agent to pull that tag into the mirror, verify Records shows the rows, then re-run and confirm all records report unchanged.
