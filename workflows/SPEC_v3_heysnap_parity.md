# SPEC v3: HeySnap Parity - One Smart Agent, Full Chrome Control, No Ceremony

Status: approved direction (Aryan, 2026-07-12). SUPERSEDES SPEC_v2_phase_i_autonomy.md
and all earlier gating/workflow constraints. Where any older spec or V2_DECISIONS entry
conflicts with this one, this one wins.

Aryan's directive, verbatim intent: this is low-effort, high-time-consumption laborious
CRM work. One smart agent in the main chat with full autonomous control of Chrome -
inspect, evaluate, click, type, whatever it decides. Give it the tools, give it
instructions, let it figure the task out, and once it has figured it out, SAVE how it
did it so the next run is fast. Remove the old workflows, the checks, the pipelines.

Blueprint: reference/heysnap/SYSTEM_PROMPT.md (adapt nearly verbatim),
reference/heysnap/BROWSER_CONTROL.md (the 3-primitive model),
reference/heysnap/WORKFLOWS_AS_SKILLS.md (memory), COMPOSER_METHOD.md (composer method),
HONEST_REVIEW_AND_DIFFERENCES.md (economy + transport).

## 1. What survives (all invisible, zero friction)

1. Never-send guard, composer-scoped ONLY (per the pending fix: page-level "Send Email"
   compose triggers are never blocked; inside an open composer, exact-name Send controls,
   send-now endpoints, plain Enter focused on a send control, and Ctrl/Cmd+Enter are
   blocked; Schedule controls always allowed).
2. No-delete blocklist (API delete-like paths refused in the extension; no delete UI
   flows in guides).
3. Stop button + one generous turn ceiling (e.g. 100 tool calls / 15 min, config
   constants) as a runaway brake, not a permission system.
4. Silent audit_events logging and the #ecw_signature snapshot/restore inside
   browser_eval. Nothing else pauses, gates, or refuses.

Everything else in the safety machinery is DELETED: pending_approvals flows, task-order
proposal/approval/scope/record-budgets, receipt-gated completion, server-driven
auto-read-back jobs, extension write-linkage refusals, TASK_PREPARATION_FAILED policy,
Tier-2 tools, deterministic email pipeline remnants, run_ui_workflow/ui_step surfaces.
Verification stays as AGENT BEHAVIOR (the soul prompt demands read-back before claiming
success), not as harness machinery.

## 2. Tool surface (10 tools, all general)

- read_workspace_file - attached files and local drafts, paged.
- db_search_records, db_get_record, db_query - the Supabase mirror as a RESOLUTION
  CACHE only (identity -> Zoho id/URL in one query). Mirror resolves candidates; Zoho
  confirms reality. (db_list_by_tag/db_list_tags/db_sync_records may stay if free, or
  fold into db_query; implementer's choice.)
- zoho_api - authenticated Zoho REST through the page session. GET/POST/PUT, module
  allowlist, delete/send-now blocklist. NO approval, NO order linkage, NO auto-receipts.
  It is the preferred method for reads, search, task create/complete, field changes -
  and their verification (read back by id after write, as behavior).
- browser_navigate, browser_observe, browser_screenshot, browser_input, browser_eval -
  full Chrome control in the dedicated background window. browser_eval is the workhorse
  (page MAIN world, #token available, frame binding for the composer iframe).
- list_skill_guides / read_skill_guide / save_skill_guide - the memory. Auto-routing of
  relevant guides into the prompt stays.

## 3. The soul prompt

Adapt reference/heysnap/SYSTEM_PROMPT.md nearly verbatim, with our environment facts and
these merged instincts (from the HeySnap review):
- Loop: observe -> reason -> act -> verify; never assume an action worked; never replay
  memorized clicks blindly; adapt from the live page.
- Method order: internal API via zoho_api first (reads, search, tasks, field writes,
  verification); UI only for UI-only flows (composer, schedule popup) or when the user
  says click/open/show.
- ADOPT, DONT RECREATE. VERIFY BY IDENTITY (ids/email attributes, never labels).
  UNVERIFIED IS NOT FAILED (flag and continue). Batch observation, serialize commitment
  (one rich eval bundle per state; commits one at a time, each verified). Target shape
  for one-email-with-tasks: parse once, one resolution query per identity, API task
  work + API read-back, composer via UI with the COMPOSER_METHOD chip recipe, schedule
  popup, one scheduled-artifact read-back. 10-14 calls.
- Safety block (all that remains): schedule means schedule, never send; no deletes;
  stay in org 890324941 and allowed modules; stop and ask on true identity ambiguity
  or missing required content; report honestly with links and exact read-back counts.
- Skills: before a task class, read the matching guides; treat as guidance not script;
  after novel work or a newly taught flow, SAVE/UPDATE a skill guide (this is Aryan's
  "once it knows how to work, we save it"). When Aryan teaches steps in chat, follow
  exactly, then distill into a guide and confirm the save.

## 4. Implementation steps (one commit per step; typecheck + remaining tests +
build:extension when extension changes; ASCII V2_DECISIONS.md checkpoints)

J1. Composer-scoped send guard fix (the pending urgent amendment: triggers outside a
    composer never blocked; exact-name classification inside; Enter-on-focused-send
    blocked; composer detection looks through iframes/overlays with a bounded mount
    wait after clicking a compose trigger). Behavioral tests.
J2. Ungate everything: zoho_api writes execute directly (no approvals, no orders, no
    auto-receipt jobs); browser tools ungated; remove order/approval requirements from
    loop, claim route, and extension; raise turn ceiling to 100 calls / 15 min. Keep
    silent audit rows. Update/retire tests with notes.
J3. New soul prompt + 10-tool surface (section 2 and 3). Remove task-order, tier-2,
    email-batch, ui_workflow, undo tools from the model surface. Update guide routing.
J4. WebSocket push transport, polling as automatic fallback (extension SW holds a WS
    to the local server, bearer-authenticated, localhost-only bind; ping ~20s; jobs
    push down, reports push up; tool_jobs rows remain the durable audit record).
J5. Deletion pass: task-orders module, approvals routes/UI, email-scheduling-tools,
    page-runner-write deterministic task prep, email-recovery-policy, tier1 wrappers,
    tier2-tools, ui-workflow runtime, receipt machinery. Trim grep proofs to: single
    fetch path GET/POST/PUT only, delete + send-now blocklists present, composer-scoped
    guard consulted, no focused/active/windows.update, WS binds localhost. Every
    retired test noted in V2_DECISIONS.md.
J6. Guide refresh: email-scheduling guide rewritten around COMPOSER_METHOD verbatim
    (chip recipe with autocomplete-hijack assertion, red-chip = failure, Loading wait,
    Cc reveal, schedule popup with zero-padded times and next-day rollover, Schedule &
    Close, scheduled-list verification); task guide around zoho_api create/complete
    with search-first adopt-dont-recreate; zoho-facts guide with env facts and the
    gotcha list. skill_guide_updated audits.
J7. Live acceptance with Aryan: attach the SAP draft, "Process this and verify
    everything." Expect the 10-14 call shape, tasks adopted (or created if he cleaned
    the deal), email scheduled 2026-07-15 10:00 AM Asia/Kolkata with signature intact,
    verified from the scheduled list, honest report with links. Measure calls and wall
    clock; log numbers.

## 5. Notes

- The mirror stays a resolution cache; a write decision is never made off mirror data
  without a live confirm.
- The extension stays the transport because it is the user's real session (HeySnap's
  own model); WS removes the polling tax that made every extra call expensive.
- Undo/change-log from Phase I is DROPPED for now per Aryan (plain CRM labor; the
  audit log still records what happened). Can be revisited later if a bad batch ever
  actually hurts.
- Old task duplicates on Deal 6834250000003329005 (ids ...348002/...348004 vs
  ...348011/...348012): report in chat if both sets still exist; do not delete records.
