# Codex Task Brief — Finish the "Move Like Snap" Migration

You are working in the repo `Zoho-Automation`. All paths below are relative to the
`zoho-agent/` package unless noted. Read the two design docs first — they are the source of
truth and this brief condenses them:

- `reference/heysnap/MIGRATION_PLAN_move_like_snap.md` (master plan, workstreams A–D)
- `reference/heysnap/IMPLEMENTATION_BRIEF_teach_distill_repeat.md` (file-level Changes A–J)

## Current state (already done — do NOT redo)

On `main` these are committed and verified (typecheck + all 59 unit tests green):

- **A1** — `db_query` accepts op `"in"` with an array value (batch record resolution) in
  `lib/agent/tier0-tools.ts`; prompt updated.
- **A5** — `tool_call_count` written to the `agent_turn` audit event metadata in
  `lib/agent/loop.ts`.
- **F.1** — `undo_record` advertised in `AGENT_TOOL_DEFINITIONS` (dispatch already existed).
- **E** — removed the `TASK_PREPARATION_FAILED` / `taskPreparationRecoveryBlocked` hard stop.
- **C-B** — `save_skill_guide` description states "method not data; params for identity slots".
- **C.2** — `guideContextForTurn` appends an available-guides catalog (name + intent).
- A2 (batch observe), A3 (prefer API), A4 (batched read-back GET) were already implemented.

## Hard guardrails (must hold throughout)

- Keep the Chrome extension, the Supabase mirror, the `#token` Zoho API pattern, and all
  safety guardrails: no record deletes, no send-now (schedule only), org `890324941`,
  modules Accounts/Contacts/Deals/Tasks, `crm.zoho.com` only.
- Do NOT move the browser into a cloud sandbox.
- Do NOT drop the `task_orders` or `pending_approvals` tables (non-destructive pass) — just
  stop writing to them.
- Do NOT embed run-specific data (ids, emails, dates, body) into skill guides.

## Working rules for every task

- Do tasks in the order below (dependency-safe): **1 → 2 → 3 → 4 → 5**.
- After each task: `npm run typecheck` and the unit tests must pass before the next.
  ```bash
  cd zoho-agent
  npm run typecheck
  npm run test:orchestrator && npm run test:records && npm run test:tier2   # test:tier2 removed in Task 4
  ```
- Where noted, also run a live smoke test (`npm run dev`, real Chrome + Zoho session): a
  one-email-two-task run, and an undo, after Tasks 2, 3, and 4.
- Commit each task separately from the repo root with the message given. Push after each.

---

## Task 1 — Prompt cleanup (Change H)

**File:** `lib/agent/loop.ts`, inside the `AGENT_INSTRUCTIONS` template (~line 170).

1. Delete the `Task orders:` paragraph (the heading line and its two bullets about
   task-order bookkeeping / old active orders).
2. Remove any remaining `ui_workflow` / `ui_step` / "deterministic email" phrasing in the
   prompt.
3. Leave intact: the `Modes: TEACH/REPEAT/EXPLORE` line, "skill guides store method not
   data", "mirror resolves, Zoho confirms before any write", composer reconciliation, and
   the substrings asserted by `tests/tier2-tools.test.ts`
   (`Modes: TEACH`, `Use zoho_api POST/PUT for CRM writes`).

**Acceptance:** typecheck + all tests green; prompt no longer mentions task orders or UI
workflows. **Commit:** `H: drop legacy task-order/ui-workflow prompt text`.

---

## Task 2 — Teach mode = live-do + distill (Change A, prompt/logic parts)

**File:** `lib/agent/loop.ts` (`instructionsForTurn`, ~line 1788).

1. Make the teach-mode turn block explicit: re-observe live first; ground the instruction
   to a real element by visible text/label/role; perform exactly ONE action with the
   general tools (`zoho_api` / `browser_*`); report what happened; wait for the next
   instruction. If the target is missing/ambiguous, state what's visible and ask — never
   guess the closest element.
2. On a save signal ("remember this" / "make a skill" / teach mode turned off after a
   successful run), the agent distills the session `agent_messages` transcript into a
   `skill_guide` via `save_skill_guide`: `intent`, `method_api` and/or `method_ui`
   (selectors as *hints to confirm live*, never a fixed click list), `gotchas`,
   `verification`, `stop_conditions`, and `params` for everything that varies. One
   confirmation, not a per-field gate.
3. Guide must contain method + gotchas + verification only — never the specific records,
   emails, dates, or body from the teach run (those become `params`).

Note: the `isUiTool` dispatch removal that Change A also lists is bundled into Task 4 (it
breaks the workflows route, so delete it there).

**Acceptance:** typecheck + tests + a live teach→save smoke that produces a data-free guide.
**Commit:** `A: teach mode does one live action per instruction and distills a guide`.

---

## Task 3 — Undo before-value store (Change F.2) — MUST precede Task 4

**Why first:** `undo_record` currently reads before-values from `pending_approvals`
(`undoActionsFromApproval`, ~`loop.ts:2124`; `undoRecord`, ~`loop.ts:2273`). Task 4 stops
writing `pending_approvals`, which would silently break undo. Give undo its own store now.

1. **Migration** `supabase/2026_v3_undo.sql`:
   ```sql
   create table if not exists public.undo_log (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null references public.users(id) on delete cascade,
     session_id uuid references public.agent_sessions(id) on delete set null,
     module text not null,               -- Accounts | Contacts | Deals
     zoho_id text not null,
     before_fields jsonb not null,       -- { apiFieldName: previousValue }
     created_at timestamptz not null default now()
   );
   -- RLS: own-or-admin read, service-role write (mirror the skill_guides policy).
   ```
2. **Write path:** in `runZohoApiTool` (~`loop.ts:1729`), before a POST/PUT to a record,
   GET the touched record's affected fields and insert an `undo_log` row. Reuse
   `zohoApiWriteTargets` (it already yields module/id/fields) so the snapshot covers exactly
   the fields being changed.
3. **Read path:** rewire `undoRecord` / `undoActionsFromApproval` (~`loop.ts:2124–2330`) to
   build undo actions from the latest `undo_log` row(s) for the record instead of
   `pending_approvals`. Keep the "scheduled emails are not revertible" messaging.

**Acceptance:** typecheck + tests + a live field-edit → `undo_record` reverts it from
`undo_log`. **Commit:** `F.2: snapshot before-values to undo_log and read undo from it`.

---

## Task 4 — Delete the legacy machinery (Change D)

Remove dispatch branches + imports in `lib/agent/loop.ts`, then delete files. Dispatch
anchors: `isTaskOrderTool` ~2617, `isEmailSchedulingTool` ~2643, `isUiTool` ~2688,
`isTier2Tool` ~2725 (keep `isUndoTool` ~2706).

1. Remove the `isTaskOrderTool` branch + task-order plumbing (`proposeTaskOrder`,
   `completeTaskOrder`, `activeTaskOrder`, `taskOrderBudgetDecision`, the budget expansion
   ~2517) and its import block. Delete `lib/agent/task-orders.ts`.
2. Remove the `isEmailSchedulingTool` branch + `runEmailSchedulingBatch`. Delete
   `lib/agent/email-scheduling-tools.ts`. `lib/agent/email-recovery-policy.ts` is unused
   after Task/Change E — delete it too.
3. Remove the `isTier2Tool` branch, `handleTier2Call`, `runTier2UnderTaskOrder`, and the
   `pending_approvals` business-verb write paths. Delete `lib/agent/tier2-tools.ts` and
   `lib/agent/tier2.ts`. Delete `tests/tier2-tools.test.ts`, `tsconfig.tier2-test.json`, and
   the `test:tier2` script in `package.json`.
4. Remove the `isUiTool` branch. Delete `lib/agent/ui-tools.ts`.
5. **Rewire the API routes that import the deleted modules** (grep-confirmed):
   - `app/api/agent/approvals/[id]/route.ts` imports `assertTier2JobInsertAllowed` from
     `tier2-tools`. This approvals endpoint is legacy — remove the route (delete the folder)
     after confirming no live caller in the extension/UI.
   - `app/api/workflows/[id]/route.ts` and `app/api/workflows/route.ts` import
     `prepareUiWorkflow` / `workflowEffectForSteps` / `PreparedUiWorkflow` from `ui-tools`.
     Remove these routes (UI workflows are replaced by skill guides) after confirming no
     live caller.
6. **Fix `tests/orchestrator-state.test.ts`** — it imports from `task-orders`, `ui-tools`,
   `tier2-tools`, and `email-scheduling-tools`. Remove those imports and the assertions that
   exercise deleted behavior; keep the rest. Update the tier2 comment reference in
   `lib/plan/field-rules.ts`.
7. Run `npx tsc --noEmit` and remove every dead symbol it names (`expandedAgentLimits`,
   `defaultTaskOrderBudget`, `verifiedWriteFollowup` if only tier2 used it,
   `PreparedUiWorkflow`, `SavedUiWorkflow`, `uiStepTeachModeDecision`, …).
8. Leave the `task_orders` / `pending_approvals` tables in place; just stop writing them.
   Remove any residual `approvals_enabled` gate branch.

**Acceptance:** typecheck + remaining tests green; a full live one-email-two-task run AND an
undo both succeed with the legacy paths gone. **Commit:**
`D: delete legacy task-order/tier2/ui/email-scheduling dispatch and files`.

---

## Task 5 — Live transport via Supabase Realtime (Workstream B / Change G)

Removes the polling tax. Today `runBridgedTool` (`lib/agent/bridge.ts`) polls `tool_jobs`
every 500ms; the extension (`extension/src/jobs.ts`) polls every 1500ms
(`ACTIVE_POLL_MS`), with an SSE pickup (`app/api/ext/jobs/stream/route.ts`).

1. **Server→extension:** extension opens a Supabase Realtime subscription (scoped
   anon/JWT minted by a new server route) to `postgres_changes` INSERT on `tool_jobs`
   filtered by `user_id`, or a broadcast channel the server publishes to after insert. On
   event, claim via the existing atomic `/api/ext/jobs/claim` (keep it — prevents
   double-run), then execute.
2. **Extension→server:** keep reporting to `/api/ext/jobs/{id}/report`. Change the server
   wait: after inserting the job, `runBridgedTool` subscribes to `postgres_changes` UPDATE
   on that row id and resolves the promise when status → done/failed. Keep
   `agentJobTimeoutMs` and ONE reconciliation poll as a safety net; common path is
   event-driven.
3. Keep `pollOnce` / `streamLoop` as a low-frequency fallback (raise `ACTIVE_POLL_MS`);
   do not delete them — they cover Realtime disconnects.

**Acceptance:** a single `zoho_api` GET round-trip drops from ~1–2s to <300ms warm; no
hot-path fixed-interval sleep. Requires live Supabase + the loaded extension to validate.
**Commit:** `B: push jobs and results over Supabase Realtime, demote polling to fallback`.

---

## Global definition of done

1. One-email-two-task run ≤ 14 tool calls (check `agent_turn` metadata `tool_call_count`)
   and under a few seconds of transport overhead.
2. Record sets resolve in one mirror/API lookup per module; no per-record fan-out.
3. UI work = one rich observation then serialized commits.
4. Data-expressible work goes through `zoho_api`, not the browser.
5. A task taught once is saved as a `skill_guide` and repeated by a fresh session with no
   re-teaching; guides hold method not data; the mirror supplies links per run.
6. No polling on the hot path; delivery + return are event-driven with a poll safety net.
7. Legacy dispatch/files gone; `tsc` and tests pass; `undo_record` works from `undo_log`.
