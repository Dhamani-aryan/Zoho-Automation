# Implementation Brief: Teach -> Distill -> Repeat, backed by Supabase

Hand-off spec for a fresh coding session. Goal, current state, and the exact changes to
make. Everything below is grounded in the real code at `Zoho-Automation/zoho-agent`.
Paths are relative to that directory. Read this whole file before touching code.

---

## 0. The goal in one paragraph

Turn the Zoho agent into a system that behaves like a smart human operator: you give it a
task, it does the task live in the user's real Chrome (reasoning step by step, not
replaying a script), it recognizes the method it used, it distills that method into a
reusable **skill guide stored in Supabase**, and from then on it can **repeat** that task
on demand. On every repeat it resolves the specific records for that run from the
**Supabase mirror** (which already stores each record's Zoho URL and IDs), confirms them
live in Zoho, and runs the learned method, adapting to the live page. The skill stores the
*method*; the mirror supplies the *data/links* per run. Those two must never be mixed.

This is not a rebuild. Both halves already exist. This brief wires them together and
removes the legacy machinery that competes with them.

---

## 1. What already exists (do not rebuild these)

- **The reasoning loop**: `lib/agent/loop.ts` runs a real tool-use loop with per-call
  feedback and a budget (100 calls / 15 min). This is the "brain." Keep it.
- **The Supabase mirror = the link book**: tables `accounts`, `contacts`, `deals`. Every
  row stores `zoho_url` plus `zoho_account_id`/`zoho_contact_id`/`zoho_deal_id`. Read via
  `db_search_records`, `db_get_record`, `db_query` (`lib/agent/tier0-tools.ts`,
  `lib/records/mirror.ts`). Refresh via `db_sync_records` (`lib/agent/tier1-tools.ts`).
- **The skill-guide store = workflow memory**: table `public.skill_guides` (schema in
  `supabase/2026_v2_phase_g.sql:35`), with structured columns `intent`, `preconditions`,
  `method_api`, `method_ui`, `gotchas`, `verification`, `stop_conditions`, `params`
  (jsonb), plus `version` and auto-`updated_at`. Tools `list_skill_guides`,
  `read_skill_guide`, `save_skill_guide` (`lib/agent/skill-guides.ts`). Seeded guides
  exist: `zoho-facts`, `deals-editing`, `contacts-editing`, `accounts-editing`,
  `email-scheduling`.
- **Guide auto-routing**: `lib/agent/guide-routing.ts` keyword-matches the user message to
  core guide names; `guideContextForTurn` (`loop.ts:551`) injects them into the turn.
- **The single live write path**: `zoho_api` -> `runZohoApiTool` (`loop.ts:1729`) ->
  `runBridgedTool`, ungated. Path allowlist + delete/send block in `lib/agent/zoho-api.ts`.
- **Teach mode is real, DB-backed, and UI-toggleable**: boolean column
  `agent_sessions.teach_mode`, read by `currentTeachMode` (`loop.ts:679`), toggled by
  `PATCH /api/agent/sessions/[id]` with `{ teach_mode: boolean }`
  (`app/api/agent/sessions/[id]/route.ts:77`), surfaced by the "Teach a workflow" /
  "Teaching" button in `components/agent-chat.tsx`.
- **Guardrails**: no-delete / no-send-now enforced server-side (`zoho-api.ts:28-60`) and
  extension-side (`extension/src/send-guard.ts`). Keep all of these.
- **Verification/undo**: read-back compare (`compareZohoApiReadBack`, `zoho-api.ts:147`);
  undo implemented in `lib/agent/undo-tools.ts` (currently un-advertised).

The advertised model toolbox is set in `AGENT_TOOL_DEFINITIONS` (`loop.ts:206-213`).

---

## 2. What fights the goal today (the code to change/remove)

The loop's dispatch switch (`loop.ts` ~2592-2745) still contains and can execute every
legacy path even though they are not advertised to the model:

- `isTaskOrderTool` -> `proposeTaskOrder` / `completeTaskOrder` (`loop.ts:2617`).
- `isEmailSchedulingTool` -> `runEmailSchedulingBatch` deterministic pipeline
  (`loop.ts:2643`) + the `TASK_PREPARATION_FAILED` hard-stop (`loop.ts:2545-2549`).
- `isUiTool` -> `ui_step` / `save_ui_workflow` / `run_ui_workflow` replay (`loop.ts:2688`).
- `isTier2Tool` -> business verbs `zoho_update_fields` / `zoho_change_owner` /
  `zoho_add_tags` / `zoho_remove_tags` via `handleTier2Call` (`loop.ts:2725`), which
  creates `pending_approvals` rows gated on `user.approvals_enabled`.
- `isUndoTool` -> `undo_task` / `undo_record` (`loop.ts:2678`) - keep the code, re-expose.

Supporting files that back the paths to remove: `lib/agent/task-orders.ts`,
`lib/agent/tier2-tools.ts`, `lib/agent/tier2.ts`, `lib/agent/ui-tools.ts`,
`lib/agent/email-scheduling-tools.ts`. Test pinning dead code: `tests/tier2-tools.test.ts`.

The teach flow currently routes to the `ui_step`/`run_ui_workflow` **replay** model
(click-lists that drift), instead of "do it live, then distill a skill guide." That is the
core rewire.

---

## 3. Target architecture (the merge)

```
              user message
                   |
        +----------v-----------+
        |   reasoning loop      |   <- the brain (keep loop.ts)
        |   modes: teach/repeat |
        +----+-----------+------+
             |           |
   resolve   |           |  learn/recall
  identities |           |  workflows
             v           v
   +---------+--+   +----+-----------+
   | mirror     |   | skill_guides   |  <- both in Supabase
   | (links/IDs |   | (method only,  |
   |  zoho_url) |   |  versioned)    |
   +---------+--+   +----+-----------+
             |           |
             v           v
        +----+-----------+----+
        | live Zoho (zoho_api  |  <- confirm + write + read-back
        |  + browser tools)    |
        +----------------------+
```

Rules that must hold in code and prompt:
1. **Skill guides store method, never data.** `params` names the slots (deal_id,
   recipient, date...) but values come from the mirror/live page per run. Enforce in the
   save flow and prompt.
2. **Mirror resolves candidates; Zoho confirms before any write.** Never write off mirror
   data alone.
3. **One bulk mirror lookup per identity/module per run**, not per record.
4. **Teach ends by writing/updating a skill guide.** Repeat begins by reading one.

---

## 4. Detailed changes

### Change A - Rewire teach mode to live-do + distill (core)

**Intent:** In teach mode the agent does exactly one real action per user instruction
using the *general* tools (`zoho_api`, `browser_*`), narrates what happened, waits for the
next instruction, and keeps a transcript. When the user says "remember this"/"make a
skill"/"save this workflow" (or the task completes), it distills the transcript into a
`skill_guide` via `save_skill_guide`.

Steps:
1. In dispatch (`loop.ts` ~2688), **remove** the `isUiTool` branch entirely. Teach mode no
   longer calls `ui_step`/`save_ui_workflow`/`run_ui_workflow`.
2. Keep teach mode as the existing `teach_mode` flag. In `instructionsForTurn`
   (`loop.ts:1790`) the teach-mode block should instruct: re-observe live first, ground the
   instruction to a real element by visible text/label/role, do that ONE action with the
   general tools, report what happened, wait; if the target is missing/ambiguous say what
   you see and ask; never guess the closest element.
3. **Transcript capture**: teach transcripts are already implicitly in `agent_messages`
   for the session (tool calls + results). The distill step should read the session's
   `agent_messages` (assistant/tool rows) and summarize them into the guide fields. No new
   table strictly required, but see Change I for an optional `teach_transcripts` helper.
4. **Distill trigger**: when the user signals save, or teach mode is turned off after a
   successful run, the model calls `save_skill_guide` with `intent`, `method_api` and/or
   `method_ui` (selectors written as *hints to confirm live*, never a fixed click list),
   `gotchas`, `verification`, `stop_conditions`, and `params` for everything that varies.
   Show the drafted guide to the user for confirmation before/при saving (a single confirm,
   not a gate on every field).
5. Prompt must say explicitly: **a distilled guide contains method + gotchas + verification
   only; it must not embed the specific records, emails, dates, or body text from the teach
   run** - those become `params`.

### Change B - Make skill guides carry record-resolution intent

**Intent:** So repeat runs resolve links from the mirror cleanly.

Steps:
1. Add a soft convention (documented in the `save_skill_guide` description in
   `lib/agent/skill-guides.ts` and in the prompt): every guide whose task touches records
   must declare `params` for the identity slots (e.g. `deal_id`, `account_name`,
   `contact_email`) and its `method_api`/`method_ui` must reference resolving those via
   `db_search_records`/`db_query` first, `zoho_api` GET to confirm.
2. No schema change needed - `params` jsonb already supports this.

### Change C - Repeat mode reads guide + resolves from mirror

**Intent:** Turn "a skill matches" into a reliable autonomous run.

Steps:
1. Repeat is prompt-level today; keep it prompt-level but strengthen. In
   `instructionsForTurn`, the non-teach block should say: if `guideContextForTurn` routed a
   guide or `list_skill_guides` shows a match, `read_skill_guide` it first, resolve the
   run's records in **one** mirror search/query per module (using `zoho_url`/IDs), confirm
   the identity live, then execute the guide's method, confirming selectors against the
   live DOM. For batches, do record #1 as a sample, then on "carry on" run the rest under
   budget + Stop, verifying each by read-back.
2. Improve `guide-routing.ts` so routing also considers **all** guides by name/intent, not
   just the 4 hard-coded `CORE_SKILL_GUIDE_NAMES`. Suggest: keep the keyword fast-path, but
   also load the list of all guide names+intents (cheap) and let the model pick. Minimal
   change: in `guideContextForTurn` (`loop.ts:551`) append a short "available guides"
   catalog (names + intents) so newly taught guides are discoverable without a code deploy.

### Change D - Delete the legacy dispatch + files

**Intent:** Make "agent-first" structural, not a prompt posture. Do this after A-C work.

Steps (remove from `loop.ts` dispatch and their imports at top of file):
1. Remove `isTaskOrderTool` branch (`~2617`) and all task-order plumbing:
   `proposeTaskOrder`, `completeTaskOrder`, `activeTaskOrder`, `taskOrderBudgetDecision`,
   budget expansion at `~2517`, and imports from `lib/agent/task-orders.ts`. Delete
   `lib/agent/task-orders.ts`.
2. Remove `isEmailSchedulingTool` branch (`~2643`) and `runEmailSchedulingBatch`; delete
   `lib/agent/email-scheduling-tools.ts`.
3. Remove `isTier2Tool` branch (`~2725`), `handleTier2Call`, `runTier2UnderTaskOrder`, and
   the `pending_approvals` write paths tied to business verbs; delete
   `lib/agent/tier2-tools.ts` and `lib/agent/tier2.ts`. Delete `tests/tier2-tools.test.ts`.
4. Remove `isUiTool` branch and delete `lib/agent/ui-tools.ts` (done partly in Change A).
5. Grep for now-dead imports/symbols and remove: `expandedAgentLimits`,
   `defaultTaskOrderBudget`, `verifiedWriteFollowup` (if only tier2 used it),
   `PreparedUiWorkflow`, `SavedUiWorkflow`, `uiStepTeachModeDecision`, etc. Compile to find
   them: `npx tsc --noEmit`.
6. Decide on `pending_approvals` and `task_orders` tables: leave the tables (harmless,
   avoids a destructive migration) but stop writing to them. Optionally add a migration
   that drops the write triggers. Do NOT drop tables in this pass.
7. Remove `approvals_enabled` branching from any remaining advertised path. The advertised
   `zoho_api`/browser/skill-guide paths already don't gate; just ensure no re-introduction.

### Change E - Remove the TASK_PREPARATION_FAILED hard stop

In `loop.ts:2545-2549` and `allowsToolAfterTaskPreparationFailure`, remove the
`taskPreparationRecoveryBlocked` mechanism. It only existed to serve the deterministic
email pipeline (deleted in D) and it recreates the dead-end pattern the review warned
about. The model should always be able to reason through a failure.

### Change F - Re-expose undo to the agent

**Intent:** The plan makes a solid undo trail the thing that justifies no approvals.

Steps:
1. Add `undo-tools` definitions to `AGENT_TOOL_DEFINITIONS` (`loop.ts:206-213`) so the
   model can call `undo_record` (and, if kept, `undo_task`). Keep the dispatch branch
   (`~2678`).
2. Ensure every `zoho_api` write records a before-value for undo. Today read-back exists;
   verify a before-snapshot is persisted (audit/undo table). If not, add a before-read in
   `runZohoApiTool` (`loop.ts:1729`) that GETs the touched record's affected fields before
   the write and stores them where `undo-tools.ts` reads them.
3. Prompt: after each write, read back, store before-value, log - never block on a
   verification miss (mark unverified + flag + continue).

### Change G - Transport (optional, lower priority)

Only if latency is a felt problem. Today both directions poll: server-side
`runBridgedTool` polls `tool_jobs` every 500ms (`lib/agent/bridge.ts`), extension polls
every 1500ms (`extension/src/jobs.ts`), with an SSE stream added as a pickup optimization
(`app/api/ext/jobs/stream/route.ts`). To finish: make the extension push results back over
a persistent channel and have `runBridgedTool` await a push instead of the 500ms poll. This
is independent of the teach/repeat merge; sequence it last.

### Change H - Prompt changes (in `AGENT_INSTRUCTIONS`, `loop.ts`)

1. Remove the "Task orders" paragraph and any `ui_workflow`/`ui_step`/deterministic-email
   references.
2. Add the three modes clearly: TEACH (one action per instruction, capture, distill),
   REPEAT (read guide, resolve from mirror, confirm live, run, verify), EXPLORE (novel:
   first-principles on one record, then propose a guide).
3. Add the two hard rules: "skill guides store method not data"; "mirror resolves,
   Zoho confirms before any write."
4. Keep the existing soul instincts (adopt-don't-recreate, verify-by-identity,
   unverified-not-failed) and composer gotchas.

### Change I - Schema (only if you want durable teach transcripts)

Optional. If reading `agent_messages` for distillation is enough, skip this. Otherwise add
a migration `supabase/2026_v3_teach.sql`:
```sql
create table if not exists public.teach_transcripts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  step_index int not null,
  instruction text,
  tool_name text,
  tool_args jsonb,
  tool_result jsonb,
  created_at timestamptz not null default now()
);
```
RLS: own-or-admin read, service-role write (mirror the `skill_guides` pattern). Then have
teach mode append a row per executed step, and the distill step read them ordered by
`step_index`.

### Change J - Tests

1. Delete `tests/tier2-tools.test.ts`.
2. Update `tests/orchestrator-state.test.ts` if it references task orders.
3. Add: a teach->distill unit test (given a fake transcript, `save_skill_guide` produces a
   guide with method+gotchas+verification and no embedded data values).
4. Add: a guide-routing test that a newly saved guide name is discoverable in the injected
   catalog (Change C.2).
5. Add: a repeat resolution test that the model instructions cause one mirror query per
   module (assert via a stubbed tool-call count on a scripted scenario, if the harness
   supports it).

---

## 5. Suggested sequence (each step compiles + tests green before the next)

1. Change H (prompt) + Change B (guide description) - low risk, no dispatch change.
2. Change A (teach rewire) + Change C (repeat strengthen + routing catalog).
3. Change F (re-expose + harden undo).
4. Change E (remove hard stop).
5. Change D (delete legacy dispatch + files) - the big cleanup, do it once A/C/E work.
6. Change J (tests) alongside each of the above.
7. Change G (transport) last, optional.

Run `npx tsc --noEmit` and `npm test` after every step. Keep the dedicated-window Chrome
extension, the `#token` internal-API pattern, the mirror, the guardrails, and the SSE/queue
transport intact unless a step explicitly changes them.

---

## 6. Acceptance criteria (how you know it's done)

1. **Teach->repeat**: in teach mode, walk the agent through a brand-new Zoho task once;
   it does it live (not by replay) and saves a `skill_guide`. A fresh session, given the
   same task by goal, reads that guide, resolves the records from the mirror, confirms live,
   and completes it with no re-teaching.
2. **Method not data**: the saved guide contains no run-specific record IDs, emails, dates,
   or body text - those are `params`.
3. **Mirror resolves, Zoho confirms**: a repeat run does one mirror lookup per module, then
   a live GET before any write; writes verify by read-back.
4. **No legacy paths**: `task-orders.ts`, `tier2-tools.ts`, `tier2.ts`, `ui-tools.ts`,
   `email-scheduling-tools.ts` are gone; `npx tsc --noEmit` and `npm test` pass; no dispatch
   branch references them.
5. **No dead-ends**: a write that acks but can't be confirmed completes as
   "unverified + flagged," never blocks; there is no TASK_PREPARATION_FAILED stop.
6. **Undo**: the agent can undo the last reversible write via an advertised tool.

---

## 7. Files this touches

Edit: `lib/agent/loop.ts` (dispatch, imports, prompt, instructionsForTurn, runZohoApiTool
before-snapshot, guideContextForTurn catalog), `lib/agent/skill-guides.ts` (description),
`lib/agent/guide-routing.ts` (catalog of all guides), `AGENT_TOOL_DEFINITIONS` (add undo).
Delete: `lib/agent/task-orders.ts`, `lib/agent/tier2-tools.ts`, `lib/agent/tier2.ts`,
`lib/agent/ui-tools.ts`, `lib/agent/email-scheduling-tools.ts`, `tests/tier2-tools.test.ts`.
Optional new: `supabase/2026_v3_teach.sql`.
Leave intact: `lib/records/mirror.ts`, `lib/agent/tier0-tools.ts`, `lib/agent/tier1-tools.ts`,
`lib/agent/zoho-api.ts`, `lib/agent/bridge.ts`, `extension/*`, `lib/agent/undo-tools.ts`.
