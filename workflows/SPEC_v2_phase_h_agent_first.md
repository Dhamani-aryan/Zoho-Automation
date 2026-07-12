# SPEC v2 Phase H: Agent-First Execution Flip

Status: approved direction (Aryan, 2026-07-12). Implementation not started.
Reference material: reference/heysnap/SYSTEM_PROMPT.md, reference/heysnap/BROWSER_CONTROL.md,
reference/heysnap/WORKFLOWS_AS_SKILLS.md, reference/heysnap/COMPOSER_METHOD.md (HeySnap's
live-verified chip-commit/schedule/verify method, 2026-07-12), uploads/HOW_I_APPROACH_A_TASK.md
(HeySnap's own description of its loop), and the live-run failure history in docs/V2_DECISIONS.md.

Root cause of the latest live failure, confirmed by COMPOSER_METHOD.md: a recipient chip
commits ONLY on an Enter keydown while the input is focused. Setting value + blur does not
commit; it orphans text in the field, and the next type appends to it, producing an invalid
address that Enter silently rejects. The deterministic runner hit exactly this
(readback To: []). The fix is method knowledge, not more pipeline code.

## 1. Why

Three consecutive live acceptance runs failed on three different brittle-script defects
(SPA identity wait, INVALID_DATA activity relation, recipient chip commit). Each failure
dead-ends because the executor is a fixed program; the model is only allowed to watch.
Meanwhile a simple one-email-two-tasks request burns 50+ tool calls and minutes of wall
clock because two systems (deterministic pipeline + model recovery) duplicate each other
across a job bridge.

Decision: invert the driver. The model drives execution through a small set of general
primitives in an observe -> reason -> act -> verify loop. Deterministic code shrinks to
safety gates, budgets, and receipt validation. Playbooks become knowledge the model reads,
not code the server executes. This is the HeySnap architecture adapted to our existing
approval/task-order machinery.

Target: the Test SAP ERP draft ("Process this and verify everything") completes in
roughly 20-25 tool calls, with live self-recovery when a UI step misbehaves. Basis
(COMPOSER_METHOD.md section 3): HeySnap prices the same request at 30-37 calls fully
UI-driven, and less than half for the API-eligible parts; our tasks go through the
internal API (create + read-back is one call each), only the composer is UI.

## 2. What stays (non-negotiable safety rails)

- LOCALHOST ONLY at http://localhost:3000; cloud Supabase; no deployment work.
- Approval gates (users.approvals_enabled), propose_task_order / complete_task_order,
  task-order budgets, Stop button polling, three-consecutive-failure and >20% failure stops.
- Extension-side refusal of any write without an approved approval_id or task_order_id.
- Schedule emails, never send immediately (hardened further in H4).
- No CRM deletes, ever. Org/module allowlist. Preserve the existing Zoho signature.
- Verify every CRM write through live read-back (restructured in H5, not weakened).
- Dedicated unfocused background browser window (65e972f behavior).
- Learn-by-doing guide updates and audit logging. ASCII-only V2_DECISIONS.md checkpoints.
- Working rule: one small step -> run tests -> one commit. Never combine steps.

## 3. What changes (summary)

REMOVE (model-facing task-specific machinery):
- schedule_zoho_email_batch tool, its server-side batch coordinator loop, and the
  scoped schedule_zoho_email deterministic extension runner (compose/chips/schedule script).
- zoho_prepare_tasks deterministic task prep in extension/src/page-runner-write.ts.
- lib/agent/email-recovery-policy.ts hard stop (cdad6a8) - obsolete once there is no
  deterministic worker whose failure needs to be protected from the model.
- Tier-2 business-verb tools: zoho_update_fields, zoho_change_owner, zoho_add_tags,
  zoho_remove_tags. Their approval/order gating machinery is retained and re-targeted
  at the new gated write primitive.
- Tier-1 read wrappers: zoho_search, zoho_get_record, zoho_get_related, zoho_read_api
  (collapsed into one zoho_api primitive).

ADD / RE-TARGET:
- zoho_api: one authenticated in-page Zoho REST primitive (reads free, writes gated).
- browser primitives exposed directly to the model: navigate, observe, eval, screenshot,
  input (CDP mouse/key). Most already exist internally; they become first-class tools.
- Hard never-send and never-delete guards inside the extension (grep-provable).
- Deterministic server-side spot verification of claimed writes (receipts survive).
- Soul-file style agent prompt; playbooks migrated to the HeySnap skill template.
- Raised loop budgets suited to an agentic loop.

KEEP AS-IS:
- Tier-0 mirror tools (db_search_records, db_get_record, db_list_by_tag, db_list_tags,
  db_query, db_sync_records), read_workspace_file, request_new_tool.
- Skill guide tools + automatic guide routing (guides become the knowledge layer).
- undo_record, teach mode / ui_step / saved UI workflows (they are HeySnap's "step mode").
- Extension job bridge transport (claim/report), receipts table/audit machinery.

Final model-facing tool surface (about 15, one write path):
read_workspace_file, db_* (6), zoho_api, browser_navigate, browser_observe, browser_eval,
browser_screenshot, browser_input, propose_task_order, complete_task_order, skill guide
read/update, undo_record, request_new_tool, ui_step (teach mode only).

## 4. Implementation steps

Each step below is one commit (or a few small commits), with tests run before each commit:
npm run typecheck, npm run lint, npm run test:tier2, npm run test:orchestrator, and
npm run build:extension whenever extension/src changes. Log every checkpoint to
docs/V2_DECISIONS.md (ASCII). Do not remove the old batch path until H6 so the app
stays usable throughout.

### H1. zoho_api read primitive

- New tool zoho_api { method: "GET", path, params?, body?: never } replacing the four
  Tier-1 read wrappers (leave the old wrappers registered but deprecated until H6).
- Path validation server-side: must match anchored /crm/v3/... or /crm/v2.2/... regexes,
  module segment checked against the existing org/module allowlist, param count capped.
- Executor: reuse the existing authenticated in-page transport (#token, X-ZCSRF-TOKEN,
  X-CRM-ORG 890324941, credentials include) already present in page-runner-write.ts;
  extract it into a shared page-runner-api.ts used by the new job type.
- Returns raw JSON (truncated by the existing TOOL_RESULT_CHAR_LIMIT), plus HTTP status.
  204 must return an explicit { status: 204, empty: true } so the model learns the
  Zoho empty-search convention.
- Tests: allowlist regexes (positive/negative), DELETE and unknown-module rejection,
  204 shaping. Grep proof: the new page runner contains exactly one fetch path.

### H2. zoho_api gated writes

- Extend zoho_api to POST/PUT (never DELETE, never PATCH). A mutating call requires an
  active approved task order (or an approval under approvals_enabled small-direct flow),
  exactly like Tier-2 writes today - reuse prepareTier2/extensionAcceptsWriteJob-style
  gating, re-pointed at zoho_api jobs.
- Record-budget accounting: each mutating zoho_api call counts its target record ids
  (body.data[].id or created rows) against the order record budget; reads count zero
  (preserves the 84f77c9 rule).
- Extension side: the executor refuses any non-GET job without approval_id/task_order_id
  linkage (keep the existing refusal helper). Blocklist regexes for delete-like and
  send-now-like API paths compiled into the extension.
- Update tier2 grep proofs: replace the old WRITE_TOOLS sync test with proofs that
  (a) the api runner has exactly one fetch path, (b) method is confined to GET/POST/PUT,
  (c) the refusal helper is called before any non-GET dispatch, (d) delete/send-now
  blocklist exists. Do not delete the refusal tests - re-target them.
- Tests: order linkage required, budget counting, blocklist.

### H3. Browser primitives as first-class tools

- Expose to the model: browser_navigate (crm.zoho.com only, dedicated background tab),
  browser_screenshot (CDP Page.captureScreenshot JPEG, existing 500 KB cap),
  browser_input (CDP Input.dispatchMouseEvent / dispatchKeyEvent with coordinates derived
  from element rects - the ui_step CDP machinery already does this; expose a direct form).
- browser_eval and browser_observe already exist; lift the Phase G restriction that
  scoped them to recovery-only. browser_eval on a composer page is how chips get fixed
  live when they fail readback.
- All browser tools require an active task order when the session's current request is
  file-driven or mutating (same activation rule the batch tool used); read-only
  observation outside an order stays allowed for teach/debug.
- Keep 65e972f invariants: never focused: true, never active: true, never windows.update.
  Extend the existing grep-proof test to the new tool paths.
- Tests: navigation host restriction, order gating, grep proofs still pass.

### H4. Hard never-send guard (this replaces prompt-level trust)

- HeySnap confirmed (COMPOSER_METHOD.md section 2) that its own never-send is discipline
  plus verification only, with no hard lock, and recommended exactly this guard. The known
  accidental-send vectors it lists are the ones to block.
- Extension content/page guard active on any crm.zoho.com composer surface while an agent
  job drives the tab: block programmatic and CDP clicks on the immediate Send control
  (identify by stable attributes AND resolve visible text at click time - never memorized
  coordinates, Send sits next to Schedule) and block eval/fetch calls to send-now
  endpoints via the H2 blocklist. Scheduling controls stay allowed.
- Block modifier+Enter (Ctrl/Cmd+Enter) key dispatch anywhere in the composer - untested
  send shortcut, treated as live risk. Plain Enter stays allowed (it commits chips and is
  safe in subject/body).
- If Send is a split button whose main body sends, only the dropdown Schedule item is
  clickable through the guard.
- If the model attempts a blocked action the tool result must say exactly why
  ("send-now is blocked; schedule instead") so the loop self-corrects in one turn.
- Grep-proof test: guard file exists, is imported by the job runner, and jobs.ts contains
  no path that dispatches trusted clicks without consulting it.

### H5. Verification receipts, agent-first shape

- Keep the receipt format from efe5bea (status, zoho id, verified fields, correlation id,
  method, elapsed, error). New rule: after every mutating zoho_api call the SERVER
  (not the model) automatically queues one GET read-back of the touched record(s) through
  the same extension transport, compares the written fields, and attaches a receipt to
  the tool result the model sees. verified / write_ok_unverified / failed survive as-is.
- The model is instructed to include receipts in its final report; complete_task_order
  rejects completion of a mutating order with zero receipts (deterministic check).
- Scheduled-email verification: the model proves it by reading the Scheduled tab /
  scheduled-mail API and the server receipt-checks the claimed schedule read-back the
  same way.
- Tests: auto-read-back receipt attach, unverified path, order completion rejection.

### H6. Prompt flip, playbooks, budgets, removal

- Rewrite agent instructions in the soul-file structure (reference/heysnap/SYSTEM_PROMPT.md):
  loop discipline, method order (internal API first, UI fallback), environment facts,
  skill reading, verification duty, stop conditions, reporting style. Keep our safety
  additions (approvals, task orders, never-send, no-delete) in the Safety block.
- Migrate the cloud skill guides (email-scheduling v7, task-create-complete v3, plus
  zoho-facts) to the WORKFLOWS_AS_SKILLS template: intent, preferred method with exact
  endpoints and copy-paste JS, UI fallback by landmarks, gotchas, verification, stop
  conditions. Fold in every gotcha from V2_DECISIONS.md live runs (204 empty search,
  parens break criteria, SPA identity wait, Tasks module pagination + What_Id filter,
  hidden hour/minute/AM-PM schedule fields, #ecw_signature preservation).
- The email-scheduling guide's composer section MUST embed the verified recipe from
  reference/heysnap/COMPOSER_METHOD.md verbatim: clear field via native setter + input
  event -> focus -> CDP insertText (or native-setter value) -> CDP Enter keyDown+keyUp ->
  verify chips by [id^="ceToAddrDetails"] li.selectedEmail email attributes AND
  leftover === "" AND no red/invalid chips. Never rely on blur. One recipient at a time,
  verify between each. Cc input (#ceCCAddr_1) exists only after clicking the Cc reveal
  control. Clear pre-filled default To chips via li.selectedEmail .closeIconB when the
  resolved recipient differs. Schedule popup: #schTimeMail time options are zero-padded
  (match both "8:00 PM" and "08:00 PM"), post-midnight times roll to the next calendar
  day, confirm the live CRM date, finish with "Schedule & Close", then verify via the
  Scheduled related list or the internal scheduled-emails API read filtered to the record.
- Budgets: raise the per-turn cap from 15 tool calls / 3 min to 60 tool calls / 10 min
  wall clock for order-linked work (config constants; keep Stop button and order budgets
  as the real limiter).
- Remove: schedule_zoho_email_batch + coordinator, schedule_zoho_email extension runner,
  zoho_prepare_tasks, email-recovery-policy.ts, deprecated Tier-1 wrappers, Tier-2
  business-verb tools. Update or remove their tests deliberately - every deleted test
  must be replaced by an H1-H5 equivalent or noted in V2_DECISIONS.md as retired with
  the reason. git diff --check clean.

### H7. Live acceptance (Aryan present; never run unattended)

- Reload extension/dist, restart the app, attach imports/samples/Test SAP ERP Email Draft.md,
  send "Process this and verify everything."
- Pass criteria: contact/deal resolved without asking; both tasks created (duplicate-skip
  on "Follow up on Test SAP ERP email"), "Prepare Test SAP ERP follow-up" completed;
  email in Scheduled with exact To (resolved address), empty CC, exact subject/body,
  preserved signature, no red/invalid chips, empty leftover in both address inputs,
  2026-07-15 10:00 AM Asia/Kolkata; every write has a verified receipt; total tool calls
  <= 25 and wall clock materially under the old runs; if a UI step fails, the model
  recovers in the same run instead of dead-ending.
- Inspect agent_sessions, agent_messages, tool_jobs, task_orders, audit_events afterward
  and log the measured numbers in V2_DECISIONS.md.

## 5. Risks and mitigations

- Model improvises a wrong write: every write is order-gated, module-allowlisted,
  budget-counted, receipt-verified, and undoable via undo_record; deletes and send-now
  are structurally impossible from the extension.
- Latency regression vs the deterministic runner: acceptable trade for self-recovery;
  playbooks with copy-paste JS keep the happy path to a handful of eval calls.
- Token cost of screenshots/DOM dumps: browser_observe stays scope-selector based;
  screenshots capped at 500 KB JPEG; TOOL_RESULT_CHAR_LIMIT unchanged.
- Losing grep-proof coverage during removal: H2/H3/H4 land the replacement proofs BEFORE
  H6 deletes the old ones.
