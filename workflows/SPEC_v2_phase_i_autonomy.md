# SPEC v2 Phase I: Autonomy - No Gates, Reversibility, Push Transport

Status: approved direction (Aryan, 2026-07-12). Supersedes the gating rules in earlier
specs where they conflict. Source: reference/heysnap/HONEST_REVIEW_AND_DIFFERENCES.md
(HeySnap's review of PROJECT_BRIEF_FOR_HEYSNAP.md) plus Aryan's decisions below.

## 0. Aryan's decisions (these override prior constraints)

1. GATES: remove per-write approvals and plan approvals for CRM record changes
   (Deals, Contacts, Accounts, Tasks). Requirement in exchange: every change must be
   recorded with before-values so it can be reversed. EXCEPTION - emails keep exactly
   one gate: the FIRST scheduled email of a batch is shown to Aryan as a sample and
   waits for approval; the rest of the batch runs unattended.
2. TRANSPORT: replace extension job polling with full WebSocket push.
3. UI RECIPES: retire run_ui_workflow from the model tool surface. Teach mode stays;
   taught flows distill into skill guides.

The old constraints "keep approval gate machinery" are superseded by this spec. These
remain non-negotiable: no CRM deletes, schedule never send, org/module allowlist,
localhost only, cloud Supabase, signature preservation, budgets + Stop button,
extension-side structural refusals, verify-by-readback (now non-blocking), ASCII
decision log, one small step -> tests -> one commit.

## 1. The model: guardrails + records, not gates

Three categories (from the HeySnap review):
- Guardrails (never ask, never cross, near-zero cost): no deletes, never send-now,
  org/module allowlist, crm.zoho.com-only browser. Structural, extension + server.
- Records (non-blocking, always on): before-value change log, read-back receipts,
  audit events, undo. These are what let the user walk away; they never pause work.
- Gates (block and wait): ONLY the first-email-of-batch sample approval remains.

## 2. Implementation steps (each = one commit; typecheck + test:tier2 +
test:orchestrator, build:extension when extension changes; log to V2_DECISIONS.md)

### I1. Soul prompt + composer knowledge + call economy (do first; unblocks live runs)

- Add HeySnap's instincts to the base instructions (adapt the appendix drop-in lines):
  AUTONOMY OVER APPROVAL (reversible work is never per-item approved; batches show a
  one-line plan, execute record #1 as a sample ONLY for emails, then run unattended;
  Stop and budgets are the control surface, not permission),
  GUARDRAILS (never delete; never send-now; stay in allowed org/modules),
  RECORDS NOT GATES (read back after every write, record before-values, log - but
  never pause or refuse to finish because of verification; unverified is not failed;
  flag and continue),
  ADOPT DONT RECREATE (before creating or typing anything, check whether the desired
  state already exists; adopt it; never re-type an already-correct value or recreate a
  matching record/task/chip),
  VERIFY BY IDENTITY (compare records, owners, chips by id/email attribute, never by
  visible label).
- Composer gotchas (instructions + email-scheduling guide next version, audit the
  guide update): autocomplete hijack - after every chip Enter, assert the committed
  chip email attribute equals the intended address exactly; if a suggestion hijacked
  the Enter, remove the chip and retry, dismissing the dropdown with Escape before
  Enter. Red/invalid chip = failure, never success. Wait out "Loading" chips (bounded)
  before judging. Cc/Bcc inputs exist only after their reveal control is clicked.
  The composer autosaves a Draft once touched - ignore drafts explicitly, do not
  treat them as evidence. Body inserted above #ecw_signature should match the
  signature font (Verdana ~13.3px) and keep the blank-line gap.
- Call economy rules in instructions: batch observation, serialize commitment. One
  browser_eval read should return the full bundle the next actions need (chips with
  email attrs, cc presence, subject value, signature presence, schedule control rect).
  Resolve record sets in one search/mirror query per module, not per record. Commits
  (chip Enter, Schedule click, Schedule & Close) stay one-at-a-time, each verified.
  Target: one-email-two-task run in 10-14 tool calls.

### I2. Send-guard fixes

- Refuse plain Enter keydown when document.activeElement is or is inside a send
  control (both CDP dispatch path and eval-installed guard).
- Stop substring-matching "Send": classify send vs schedule controls by exact
  accessible name / role + aria attributes; "Resend", "Send test", etc. must not be
  blocked as false positives; a split button whose accessible name is "Send email"
  must be blocked on its main body.
- Keep elementFromPoint recheck at dispatch time. Update grep proofs accordingly.

### I3. Receipts: non-blocking + batched

- write_ok_unverified and field mismatches: flag in the result and the final report,
  schedule one cheap by-id re-read attempt, and CONTINUE. complete_task_order never
  refuses for unverified/zero receipts anymore; it attaches receipt stats and flags
  to the completion report instead. Remove the composer-mutation completion refusal
  the same way (the email gate in I5 replaces it).
- Batch read-backs: verify N touched records with one GET (id in (...)) per module
  instead of N GETs. UI schedules are verified from the record's Emails -> Scheduled
  related list / scheduled-mail read in one call, not by re-observing the composer.

### I4. Reversibility: universal change log + undo (prerequisite for I5)

- New change_log table (Supabase migration, ASCII SQL file): id, user_id, session_id,
  task_order_id, module, zoho_id, field_before jsonb, field_after jsonb,
  correlation_id, created_at, undone_at, undo_of (nullable self-reference).
- Before every mutating zoho_api call the server fetches the target records' current
  values for exactly the fields being written (one batched GET) and writes
  change_log rows; the receipt read-back fills field_after. Created records (POST)
  log field_before: null and record the created id.
- Extend undo: undo_record works from change_log for any logged field/owner/tag
  change on Deals/Contacts/Accounts/Tasks (write back field_before via the same
  gated zoho_api path, logged as a new change_log row with undo_of set). Undoing a
  created Task = set Status Completed with subject prefix "[undone]" is NOT wanted;
  instead: created Tasks are reversed by marking them Cancelled/Completed only if
  Aryan asks; document that created records cannot be deleted (no-deletes guardrail)
  and are therefore flagged, not auto-reversed.
- Scheduled-email reversal: implement an unschedule capability (open the scheduled
  email in Zoho UI / API and cancel the schedule) exposed as part of undo for email
  records, or document precisely why it is deferred if Zoho blocks it.
- UI for the change log: extend the existing activity/admin page with a change list
  and per-row undo buttons (batch undo for a task order).

### I5. Gate removal (after I4 lands)

- zoho_api POST/PUT on Deals/Contacts/Accounts/Tasks: no pending_approvals row, no
  waiting. Requires an active task order for batch/file-driven work as a BUDGET
  container only: propose_task_order auto-approves immediately (still audited, still
  Stop-able, still budgeted); watched small direct writes run without an order.
- Extension structural refusal stays but re-targeted: non-GET zoho_api jobs must
  carry a task_order_id or session linkage produced by the server (defense in depth
  against forged jobs), not a user approval.
- EMAIL SAMPLE GATE (the one gate): in a batch email order, the agent composes and
  schedules email #1, verifies it in Scheduled, then emits an approval_required with
  the sample (recipient, subject, date/time, body preview, screenshot) and WAITS.
  On approve ("carry on") the remaining emails run unattended with per-record
  verification; on reject, the agent unschedules email #1 (I4 capability) and stops.
  A single-email request behaves the same: schedule, show sample; approval closes
  the order.
- Update tests: claim-route decisions, order lifecycle, removal of per-write approval
  paths. Keep approvals table/machinery code only for the email sample gate.

### I6. Retire run_ui_workflow from the model surface

- Remove run_ui_workflow (and list_ui_workflows if now unreachable) from
  AGENT_TOOL_DEFINITIONS. Keep teach mode ui_step. After a taught flow succeeds,
  the agent proposes a skill guide distillation (existing save_skill_guide path).
  Existing saved workflows stay in the DB and admin UI for reference; the model
  cannot execute them. Update instructions and retire their surface tests with
  V2_DECISIONS.md notes.

### I7. WebSocket push transport

- Replace claim polling with a WebSocket: the extension service worker holds a WS to
  the local server (custom Node server alongside Next on localhost, or a dedicated
  ws port started by npm run dev - keep it localhost-only and bearer-authenticated
  with the existing extension token). Server pushes queued jobs; extension pushes
  reports; the server-side waiters resolve immediately instead of polling tool_jobs.
- MV3 lifetime: WS activity extends service-worker life (Chrome 116+); send a ping
  every ~20s; on socket drop, reconnect with backoff; keep the existing 1-minute
  alarm + polling path as automatic FALLBACK so a WS failure degrades to today's
  behavior instead of breaking runs.
- tool_jobs rows remain the durable record (insert before push, report persisted on
  receipt) so audit, recovery, and the admin UI are unchanged.
- Tests: pure decision helpers for push/fallback selection and report handling;
  grep proof that the WS server binds localhost only.

### I8. Deletion pass + grep-proof trim

- Delete: schedule_zoho_email_batch coordinator + contract + resolver,
  schedule_zoho_email extension runner, zoho_prepare_tasks, email-recovery-policy
  hard stop, deprecated Tier-1 read wrappers, Tier-2 business-verb write tools and
  their approval plumbing (except what the email sample gate reuses).
- Trim grep proofs to catastrophic invariants only: single fetch path confined to
  GET/POST/PUT, delete/send-now blocklists present, no focused/active/windows.update,
  send guard consulted on input paths, extension write-linkage refusal, WS localhost
  bind. Every retired test gets a V2_DECISIONS.md note naming its replacement.

### I9. Live acceptance (Aryan present)

- Reload extension, restart app, attach the SAP test draft, "Process this and verify
  everything." Expect: records resolved, tasks adopted (no writes needed), email #1
  composed with correct chip reconciliation (pre-filled chip adopted, no false
  ambiguity), scheduled for 2026-07-15 10:00 AM Asia/Kolkata, sample shown for
  approval, order completed with receipts + change log, 10-14 tool calls, materially
  faster wall clock with WS transport. Inspect Supabase logs and log the measured
  numbers.

## 3. Risks

- Gate removal with immature undo: I4 is a hard prerequisite for I5; do not reorder.
- WS in MV3: fallback polling stays; failure mode is latency, not breakage.
- Autocomplete hijack is the main wrong-recipient vector: I1 assertion (committed
  email === intended, exact) is the defense; the email sample gate catches template
  errors before the batch repeats them.
