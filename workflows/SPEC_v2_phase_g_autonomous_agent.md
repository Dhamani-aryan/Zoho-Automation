# V2 Phase G Build Spec — Task-Autonomous Agent (HeySnap architecture adoption)

Version 1.0 (2026-07-10). For Codex. Prereq: Phase F + follow-ups reviewed (through a84852f + review fixes).
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

- The 50-email scenario: hand the agent a drafts md file → ONE approval card listing every scheduled email (recipient, subject, date/time) → approve → it schedules all via its own method choice, verifies each in the Scheduled view, and delivers a counts report. Zero mid-run questions.
- Teach-once: walk through one novel flow in teach mode → agent drafts and saves a guide → next session, same task with different params completes with no walkthrough.
- browser_eval without an active order → approval card with the code; approve → runs; audit row present.
- Stop button aborts an in-flight order and nothing executes after.
- typecheck/lint/build/build:extension green; V2_DECISIONS checkpoints logged (ASCII).

## 8. Review checklist (chat will verify)

Task-order gate server-side (no eval/write job without approval_id OR approved order id — extension belt included); order budgets enforced; expected_changes vs actual records touched reconciled in the report; card shows the full plan; audit completeness for eval; guide save behind confirmation; system prompt keeps verification + stop conditions; legacy gates (Tier-2 cards, teach gating for out-of-order UI mutations) still grep-provable.
