# Remaining Migration Steps — Snap Parity (execute in a healthy local checkout)

Status baseline: `main` is at commit `2d11444` and contains, already done and verified
(typecheck + all 59 unit tests green):

- **A1** batched `db_query` (`in` op) — resolve a record set in one mirror call
- **A5** `tool_call_count` in `agent_turn` audit metadata (measurable runs)
- **F.1** `undo_record` re-exposed to the agent
- **E** removed the `TASK_PREPARATION_FAILED` recovery dead-end
- **C-B** `save_skill_guide` convention: method-not-data, params for identity slots
- **C.2** available-guides catalog injected into turn context (taught guides discoverable)
- (A2 batch-observe, A3 prefer-API, A4 batched read-back were already present)

Everything below is what remains. **Do it locally**, not in the Cowork sandbox — that
environment corrupts git's index on the `G:` mount. Run `npm run typecheck` and the
`test:*` scripts after each step; do one live scheduled-email smoke test after A, F.2, and D.

Order (dependency-safe): **H → A → F.2 → D → B**.

---

## Precondition

```bash
cd "G:\Zoho Automation"
git status                      # clean, at 2d11444, pushed
cd zoho-agent
npm run typecheck && npm run test:orchestrator && npm run test:records && npm run test:tier2
```

---

## Step H — Prompt cleanup (`lib/agent/loop.ts`, `AGENT_INSTRUCTIONS`)

Low risk, prompt-only. Anchors are around lines 170–172 and 141/196.

1. **Delete the "Task orders:" paragraph** (the two bullet lines beginning
   `- Task orders are legacy bookkeeping...` and `- If an old active order...`). Task
   orders no longer gate anything; the internal ledger + budget + Stop replace them.
2. Remove any lingering `ui_workflow` / `ui_step` / "deterministic email" phrasing.
3. Confirm the three modes (TEACH/REPEAT/EXPLORE) and the two hard rules
   ("skill guides store method not data"; "mirror resolves, Zoho confirms before any
   write") are stated — they already are; keep them.
4. `tests/tier2-tools.test.ts` asserts a few prompt substrings (`Modes: TEACH`,
   `Use zoho_api POST/PUT for CRM writes`, composer reconciliation). Don't remove those.

Verify: typecheck + tests. Commit: `H: drop legacy task-order/ui-workflow prompt text`.

---

## Step A — Teach mode = live-do + distill (`lib/agent/loop.ts`)

Intent: in teach mode the agent does exactly ONE real action per instruction with the
**general** tools (`zoho_api` / `browser_*`), narrates, waits, keeps a transcript; on
"remember this"/"make a skill"/teach-off it distills into a `skill_guide`.

1. In `instructionsForTurn` (~line 1788) the teach-mode branch should instruct:
   re-observe live first; ground the instruction to a real element by visible
   text/label/role; do ONE action with the general tools; report what happened; wait; if
   the target is missing/ambiguous, say what's visible and ask; never guess the closest
   element. (Most of this is present in the "Modes: TEACH" line — make it the explicit
   teach-turn block.)
2. Distill: the transcript already lives in `agent_messages` for the session. On save
   signal, the model calls `save_skill_guide` with `intent`, `method_api`/`method_ui`
   (selectors as *hints to confirm live*, never a fixed click list), `gotchas`,
   `verification`, `stop_conditions`, `params` for everything that varies. One confirm,
   not a per-field gate.
3. The `isUiTool` removal that the brief lists under Change A is done as part of **Step D**
   below (it breaks the workflows route, so batch it with the deletion).

Verify: typecheck + tests + a live teach→save smoke test. Commit:
`A: teach mode does one live action per instruction and distills to a guide`.

---

## Step F.2 — Persist a before-value snapshot for undo (DO THIS BEFORE STEP D)

Why first: `undo_record` currently reads its before-values from `pending_approvals` rows
(`undoActionsFromApproval`, ~loop.ts:2124). Step D stops writing `pending_approvals`, which
would silently break the undo you just exposed. So give undo its own before-value store
first.

1. **Schema** — new migration `supabase/2026_v3_undo.sql`:
   ```sql
   create table if not exists public.undo_log (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null references public.users(id) on delete cascade,
     session_id uuid references public.agent_sessions(id) on delete set null,
     module text not null,               -- Accounts | Contacts | Deals
     zoho_id text not null,
     before_fields jsonb not null,       -- { field: previousValue }
     created_at timestamptz not null default now()
   );
   -- RLS: own-or-admin read, service-role write (mirror skill_guides policy).
   ```
2. **Write the snapshot in the write path** — in `runZohoApiTool` (~loop.ts:1729), before a
   POST/PUT to a record, GET the touched record's affected fields and insert an `undo_log`
   row with `before_fields`. Reuse `zohoApiWriteTargets` (already computes module/id/fields)
   so the before-read covers exactly the fields being changed.
3. **Rewire undo to read the new store** — change `undoRecord`/`undoActionsFromApproval`
   (~loop.ts:2124–2330) to build undo actions from the latest `undo_log` row(s) for the
   record instead of `pending_approvals`. Keep the "scheduled emails aren't revertible"
   messaging.
4. Prompt: after each write → read back, store before-value, log; never block on a
   verification miss (mark unverified + flag + continue). (E already removed the hard block.)

Verify: typecheck + tests + a **live** field edit then `undo_record` against real Zoho.
Commit: `F.2: snapshot before-values to undo_log and read undo from it`.

---

## Step D — Delete the legacy machinery (the big cleanup, do last of the code changes)

Remove dispatch branches + imports in `lib/agent/loop.ts`, then delete files. Anchors:
`isTaskOrderTool` ~2617, `isEmailSchedulingTool` ~2643, `isUiTool` ~2688, `isTier2Tool`
~2725.

1. Remove the `isTaskOrderTool` branch and all task-order plumbing (`proposeTaskOrder`,
   `completeTaskOrder`, `activeTaskOrder`, `taskOrderBudgetDecision`, budget expansion at
   ~2517) and the import block. **Delete** `lib/agent/task-orders.ts`.
2. Remove `isEmailSchedulingTool` branch + `runEmailSchedulingBatch`. **Delete**
   `lib/agent/email-scheduling-tools.ts`. (`email-recovery-policy.ts` is already unused
   after E — delete it too or leave it; it's not imported.)
3. Remove `isTier2Tool` branch, `handleTier2Call`, `runTier2UnderTaskOrder`, and the
   `pending_approvals` business-verb write paths. **Delete** `lib/agent/tier2-tools.ts` and
   `lib/agent/tier2.ts`. **Delete** `tests/tier2-tools.test.ts` and its
   `tsconfig.tier2-test.json` + the `test:tier2` script in `package.json`.
4. Remove the `isUiTool` branch. **Delete** `lib/agent/ui-tools.ts`.
5. **Rewire the two API routes that import these modules** (grep confirmed):
   - `app/api/agent/approvals/[id]/route.ts` imports `assertTier2JobInsertAllowed` from
     `tier2-tools`. This whole approvals endpoint is legacy — remove the route (delete the
     folder) OR inline a minimal guard if any client still calls it. Check the extension/UI
     for callers first.
   - `app/api/workflows/[id]/route.ts` and `app/api/workflows/route.ts` import
     `prepareUiWorkflow`/`workflowEffectForSteps`/`PreparedUiWorkflow` from `ui-tools`.
     Remove these routes (UI workflows are replaced by skill guides) after confirming no
     live caller.
6. **Fix `tests/orchestrator-state.test.ts`** — it imports from `task-orders`, `ui-tools`,
   `tier2-tools`, and `email-scheduling-tools`. Remove those imports and the assertions that
   exercise deleted behavior; keep the orchestrator-state assertions that don't.
   `lib/plan/field-rules.ts` only *references* tier2 in a comment — update the comment.
7. Compile to sweep dead symbols: `npx tsc --noEmit` will name every now-unused import
   (`expandedAgentLimits`, `defaultTaskOrderBudget`, `verifiedWriteFollowup` if only tier2
   used it, `PreparedUiWorkflow`, `SavedUiWorkflow`, `uiStepTeachModeDecision`, etc.).
8. **Leave the `task_orders` and `pending_approvals` TABLES** in place (non-destructive);
   just stop writing to them. Remove any `approvals_enabled` branch from remaining paths.

Verify: typecheck + remaining tests + a full live one-email-two-task run **and** an undo,
confirming both still work with the legacy paths gone. Commit:
`D: delete legacy task-order/tier2/ui/email-scheduling dispatch and files`.

---

## Step B — Live transport (Supabase Realtime), replaces the polling tax

Independent; do after the above. Today `runBridgedTool` (`lib/agent/bridge.ts`) polls
`tool_jobs` every 500ms and the extension (`extension/src/jobs.ts`) polls every 1500ms.

1. **Server→extension**: extension opens a Supabase Realtime subscription (scoped
   anon/JWT the server mints) to `postgres_changes` INSERT on `tool_jobs` filtered by
   `user_id`, or a broadcast channel the server publishes to right after insert. On event,
   claim via the existing atomic `/api/ext/jobs/claim` (keep it — prevents double-run),
   then execute. Removes the 1500ms poll from the hot path.
2. **Extension→server**: keep reporting to `/api/ext/jobs/{id}/report`. Change the server
   wait: after inserting the job, `runBridgedTool` subscribes to `postgres_changes` UPDATE
   on that row id and resolves the moment status → done/failed. Keep `agentJobTimeoutMs`
   and ONE reconciliation poll as a safety net; the common path is event-driven.
3. Keep `pollOnce`/`streamLoop` as a low-frequency fallback (raise `ACTIVE_POLL_MS`); don't
   delete — they cover Realtime disconnects.

Acceptance: a single `zoho_api` GET round-trip drops from ~1–2s to <300ms warm; no hot-path
fixed-interval sleep. This one needs real Supabase + the extension loaded to validate — do
it entirely locally with a live session.

---

## After each step

```bash
cd "G:\Zoho Automation\zoho-agent"
npm run typecheck
npm run test:orchestrator && npm run test:records   # (test:tier2 removed in D)
# then commit from the repo root:
cd "G:\Zoho Automation" && git add -A && git commit -m "<message above>" && git push origin main
```

Record the `tool_call_count` (now in the `agent_turn` audit metadata) and wall-clock for a
one-email-two-task run before and after B, so the speedup is measured, not assumed.
