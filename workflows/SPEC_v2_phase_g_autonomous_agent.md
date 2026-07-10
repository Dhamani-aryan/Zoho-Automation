# V2 Phase G Build Spec — Task-Autonomous Agent (HeySnap architecture adoption)

Version 1.2 (2026-07-10; §8 items 1–5 = live-run follow-ups, items 6–7 = gates-off-by-default + undo — these AMEND §1/§2/§3). For Codex. Prereq: Phase F + follow-ups reviewed (through a84852f + review fixes).
Read first: `reference/heysnap/Zoho Agent Blueprint.md` (and the three companion docs in the same folder — they are the architecture reference for this phase), `docs/V2_DECISIONS.md` recent entries, `workflows/SPEC_v2_tool_agent_migration.md`.

## 0. Decision record (Aryan, 2026-07-10 — supersedes earlier rules where stated)

After comparing live behavior with HeySnap, Aryan decided:
1. **Task-level autonomy.** Give the agent a task ("schedule the emails in this 50-contact md file") and it executes end to end without per-step confirmation. The one-step-per-instruction teach grind is dropped.
2. **Full `browser_eval` (arbitrary in-page JS) is adopted.** This SUPERSEDES migration-spec §8.4 "no arbitrary code execution tool". Risk understood and accepted by Aryan: model-written JS in the logged-in session can do anything the session can; the mitigations are the task-approval scope (§1), full code audit, verification, and stop conditions — not per-call validation.
3. **Approval moves from per-action to per-task.** Aryan's locked rule "preview + approval before CRM changes — always" REMAINS, satisfied by ONE preview/approval card per task (covering the whole batch), not one per write. Read-only work needs no approval (unchanged).
4. **Workflows become self-authored skill guides** (intent + method + gotchas + verification), written by the agent after doing a task once (walked through in teach mode or worked out itself), then read on demand next time. Frozen click-script replays are demoted to a legacy path.

Unchanged and still binding: no deletes, schedule-never-send, org 890324941 / Deals-Contacts-Accounts only, verify every write by read-back, audit everything, JSON errors, timeouts, fail-before-side-effects on config errors, localhost only (no Vercel work), commits authored as Aryan Dhamani (dhamaniaryan4@gmail.com) with no AI co-author.

## 1. Task orders (per-task approval scope)

Migration `2026_v2_phase_g.sql`: table `task_orders` (id, session_id FK, user_id FK, goal text, plan jsonb, scope text check in ('read','write'), status text default 'proposed' check in ('proposed','approved','rejected','expired','completed','failed'), budget jsonb, decided_at, completed_at, created_at). RLS owner-read; service-role writes.

- New tool `propose_task_order { goal, plan_summary, expected_changes: [{record, action, detail}], scope: read|write }`. For scope=write the loop inserts the row + renders an approval card (reuse the card UI; summary = expected_changes). Approved → the session has an ACTIVE task order; rejected/expired → observation to the model.
- scope=read task orders auto-approve (reads were never gated) but are still recorded.
- While a task order is active: `browser_eval`, UI steps, and Tier-2 write tools tagged with the order id execute WITHOUT further cards. Server stamps `task_order_id` on tool_jobs; the extension refuses eval/write jobs lacking either an approval_id OR an approved task_order_id (extend the existing belt-and-braces checks, same pattern).
- Order budgets (in `budget` jsonb, env-default): max 200 tool calls, 45 min wall clock, max records touched = expected_changes length + 10%. Budget trip → order `failed`, execution stops, report what happened.
- Completion: agent calls `complete_task_order { report }` → status completed, report persisted + shown in chat (counts, per-record status, Zoho links, failures with reasons — the §Reporting format from the HeySnap soul file).
- One active order per session. Existing per-call Tier-2 approval cards still work for small one-off asks outside any order (unchanged path).
- Mid-run stop: chat Stop button also flips the active order to `failed` (server-side check each loop iteration), halting further tool execution — this is the user's abort lever during autonomous runs.

## 2. `browser_eval` (the HeySnap workhorse)

- Tool `browser_eval { code, purpose, await_promise?: true }` — model-written JS executed in the crm.zoho.com page MAIN world via the existing executor plumbing; JSON-serializable return, 64 KB result cap, 30 s timeout.
- Gating: allowed ONLY (a) under an active approved task order, or (b) via a per-call approval card showing `purpose` + full `code` (for one-offs). Never silently.
- Audit every call: purpose, sha256(code), byte length, task_order_id, ok/error. Full code persisted in agent_messages tool_args (it already is) — the trace is the code review.
- crm.zoho.com tabs only (existing background enforcement applies).
- The agent's method order (system prompt, §5): internal API via `#token` first (the deterministic Tier-1/2 tools remain the PREFERRED path when they fit — cheaper and pre-validated); `browser_eval` when the toolbox doesn't fit; UI steps only for UI-only flows.

## 3. Observation + autonomous UI acting

- New step/tool `browser_observe {}` → current URL, page title, visible headings, and visible interactive controls (tag, text, approximate selector) capped ~16 KB — the feedback that lets the model FIND controls instead of being dictated selectors. Read-only, no approval, works in teach mode and under task orders.
- Teach mode changes: the one-ui_step-per-instruction rule is DELETED from instructions. In teach mode the agent takes a goal, chains observe → act (CDP) → verify, streaming each step; the user watches the dedicated window and can Stop. Teach mode's real purpose becomes the walkthrough for guide authorship (§4).
- UI steps under an approved write task order run without teach mode (autonomy per decision 1). Outside an order and outside teach mode, mutating UI steps stay blocked (unchanged).

## 4. Skill guides (workflows-as-skills, learn-by-doing)

Migration adds `skill_guides` (id, name unique, intent text, preconditions text, method_api text, method_ui text, gotchas text, verification text, stop_conditions text, params jsonb, version int, created_by, timestamps). Editable in the `/workflows` page (new "Guides" tab beside the legacy step workflows).

- Tools: `list_skill_guides {}` (Tier 0), `read_skill_guide { name }` (Tier 0), `save_skill_guide { ...fields }` (confirmation card, same pattern as save_ui_workflow; version bump on same name).
- The learn-by-doing rule (system prompt): after completing a task with no matching guide — whether walked through in teach mode or worked out solo — DRAFT a guide ("everything you would need to redo this without the user walking you through it", parameterizing what varies: recipient, field value, date/time) and propose saving it. Next time, read it and run.
- Seeding: Codex converts the four playbooks in `source_docs/` + `reference/ZOHO_SESSION_API_REFERENCE.md` facts into initial guides using the `_template` structure from `reference/heysnap/WORKFLOWS_AS_SKILLS.md` (zoho-facts, deals-editing, contacts-editing, accounts-editing, email-scheduling, task-create-complete). Method-API sections carry the exact copy-paste JS patterns.
- Legacy `ui_workflows` (step scripts) remain runnable but the UI labels them "legacy"; no new development.

## 5. System prompt rewrite

Replace AGENT_INSTRUCTIONS with an adaptation of `reference/heysnap/SYSTEM_PROMPT.md` (the soul file), merged with our specifics: task-order approval flow, tool tiers and method order (deterministic tools → browser_eval → UI), guide reading/writing rules, teach-mode-as-walkthrough, verification (never report success without read-back), stop conditions (identity mismatch, missing data, >1 match, duplicates, Zoho errors, logged out, 3-fail/20% stop), reporting format, style ("do the work; don't narrate every step" — directly addresses the 'say do it' annoyance). Keep ASCII. Keep the mirror-vs-live source-labeling rule.

## 6. Build order

1. Migration + task_orders + propose/complete tools + card + budgets + Stop integration.
2. browser_eval end to end (server gate → job → extension MAIN-world exec → audit), with per-call card path.
3. browser_observe + teach-mode multi-step instructions + system prompt rewrite (§5).
4. skill_guides table + tools + /workflows Guides tab + seeding from playbooks.
5. Learn-by-doing drafting rule + guide-first routing in instructions.

## 7. Done-when (live, Aryan)

- The batch-email scenario, using the REAL input format at `imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md` (23 contact sections; header block carries the batch rules: two-emails-per-account persona mapping, "use the first subject line", CC list, 8:00 PM time, body ends at "Best," keeping the Zoho signature): hand the agent the file → it asks ONE question (the schedule date, which the file marks TBD) → runs as an auto-approved task order (gates default OFF per §8.6) → schedules every email, verifies each (recipient chips + subject + date/time via read-back and the Scheduled tab), and delivers a counts report with per-record status and an Undo section for anything revertible. Zero other mid-run questions. The email-scheduling guide must encode this file format so future batches parse without re-teaching.
- Teach-once: walk through one novel flow in teach mode → agent drafts and saves a guide → next session, same task with different params completes with no walkthrough.
- browser_eval without an active order → approval card with the code; approve → runs; audit row present.
- Stop button aborts an in-flight order and nothing executes after.
- typecheck/lint/build/build:extension green; V2_DECISIONS checkpoints logged (ASCII).

## 8. Follow-ups from the first live run (v1.1 — Aryan, 2026-07-10; these AMEND §1–§3)

1. **Interactive browser work is ungated.** `ui_step`, `browser_observe`, `browser_eval` execute immediately in a user-directed chat session — no task order, no card, no teach-mode requirement (the watched dedicated window is the approval; audit + verification + stop conditions remain). `propose_task_order` (one card) is required ONLY for unattended/batch multi-record work — concretely: the agent must propose an order when a task will touch more than 3 records or run without the user directing each stage; otherwise it must NOT propose one. Tier-2 API write tools keep their per-call cards when used outside an order (unchanged). Teach mode's toggle remains only to signal a walkthrough (triggers the guide-drafting rule); it gates nothing. Update instructions, loop gating, and the extension belt checks accordingly (extension: eval/ui jobs no longer need order/approval linkage; API-write jobs still do; keep the write-tool linkage checks EXACTLY as they are).
2. **Automatic guide context (intent routing).** Per turn, deterministically match the user message + recent tool activity against `skill_guides` (name, intent keywords, simple keyword column added to the table if needed) and inject the top 1–2 matching guides' content into the model context (capped ~6 KB each), labeled as loaded guides. The agent is also instructed: before email/UI-heavy work, `read_skill_guide` anything relevant that wasn't auto-loaded. Acceptance: saying "click compose email" loads the email-scheduling guide without being asked.
3. **Email guide must be real.** Seed/verify `email-scheduling` guide containing the KD Blitz playbook §9 selector map and composer mechanics: compose overlay structure, To-field chip input (type + real Enter to commit), subject input, body = contentEditable inside an IFRAME (document the frame selector; use `frame_selector` on steps or eval within the frame), Verdana 13.33px body rules, schedule-never-send popup flow, verification via chip read-back + Scheduled tab.
4. **Observation must see overlays and iframes.** `browser_observe` descends into same-origin iframes (composer body) and open dialogs/overlays, marks each control with its frame, and supports `scope_selector` to observe only within a dialog (keeps results under the cap instead of truncating the whole page). Raise the useful signal, not the byte cap.
5. CDP stays the preferred input path; the debugger banner is accepted (no mitigation work).
6. **(v1.2, Aryan 2026-07-10) All approval gates default OFF.** Add `users.approvals_enabled boolean not null default false` (migration). When FALSE (default): Tier-2 API writes, batch task orders, eval, and UI steps execute immediately with no cards; `propose_task_order` still runs for batch work but auto-approves (recorded, budgeted, reported — the order becomes a work log, not a gate). When TRUE: the v1.0/v1.1 card behavior, unchanged. The flag is per-user, admin-editable in Settings. DO NOT delete the gate machinery — it must remain fully functional behind the flag (future teammates). NON-OPTIONAL regardless of flag: before/after capture on every write, read-back verification, full audit (incl. eval code), stop conditions, schedule-never-send, no deletes, org/module allowlist, batch budgets.
7. **(v1.2) Undo.** Because "undoable" is now the safety story: `undo_task { task_order_id }` and `undo_record { module, zoho_id, fields? }` tools + an Undo button on task reports — revert fields/owner/tags to the logged before-values via the normal write executor (verified read-back, audited as `undo`). Scheduled emails: undo = delete-the-schedule is NOT available via API in scope; the guide documents the manual path (Scheduled tab -> delete), and undo reports list any non-revertible items explicitly.

## 9. Review checklist (chat will verify)

Task-order gate server-side (no eval/write job without approval_id OR approved order id — extension belt included); order budgets enforced; expected_changes vs actual records touched reconciled in the report; card shows the full plan; audit completeness for eval; guide save behind confirmation; system prompt keeps verification + stop conditions; legacy gates (Tier-2 cards, teach gating for out-of-order UI mutations) still grep-provable.
