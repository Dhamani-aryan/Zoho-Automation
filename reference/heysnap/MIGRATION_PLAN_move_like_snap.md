# Migration Plan: Make the Zoho Agent Move Like Snap

Master hand-off brief for a fresh Claude Code session. It is self-contained: it explains
the system, the tools, the current bottlenecks, and the exact migration in ordered
workstreams. Read the whole file before editing. All paths are relative to
`Zoho-Automation/zoho-agent`. Line numbers are approximate; confirm with a grep.

Companion doc (file-level detail for the teach/repeat workstream):
`IMPLEMENTATION_BRIEF_teach_distill_repeat.md` in the same folder. This master plan
references it; do not duplicate, follow it for Workstream C specifics.

---

## PART 1 - Understand the system before changing it

### 1.1 What this product is

A Zoho CRM agent. A user types a plain-English task (often with an attached CSV/markdown
of records or email drafts). The agent reasons in a loop, resolves the records, and
performs the work **inside the user's own logged-in Zoho session in their real Chrome**,
then verifies and reports. It is an internal KloudData tool.

### 1.2 The four moving parts

1. **The Next.js app + agent loop** (`lib/agent/loop.ts`) - the "brain." Runs a tool-use
   loop: read goal -> call a tool -> see the result -> decide the next call, until done.
   Hosted as a Next.js app (serverless-style API routes under `app/api/...`).
2. **Supabase** - the datastore. Holds:
   - the **mirror** (`accounts`, `contacts`, `deals` tables) = a local copy of Zoho
     records including each record's `zoho_url` and Zoho IDs. This is the agent's fast
     "link book" so it doesn't have to search Zoho to find a record's URL.
   - **`skill_guides`** = learned, versioned playbooks (method + gotchas + verification).
   - **`tool_jobs`** = the job queue that carries browser/API actions to the extension.
   - agent sessions, messages, audit log, undo before-values.
3. **The Chrome extension** (`extension/`) - runs in the user's real Chrome, holds the
   user's live Zoho session, and executes browser/API actions against `crm.zoho.com`. This
   is the ONLY thing that can act as the user. It must stay.
4. **Zoho CRM** - the system of record. Reached two ways: the internal `#token` API
   (fast, for data) and the live UI (for the email composer/scheduler).

### 1.3 The tool surface the agent (model) can call

Advertised set is `AGENT_TOOL_DEFINITIONS` (`loop.ts:206-213`):

- `read_workspace_file(path, page?)` - read an attached CSV/markdown (drafts, record lists).
- `db_search_records(module, query)` / `db_get_record(module, id)` / `db_query(module,
  filters)` - read the Supabase mirror (fast, in-process, returns `zoho_url` + IDs).
- `db_sync_records(module, ids?)` - refresh the mirror from live Zoho.
- `zoho_api({method, path, params?, body?})` - THE live CRM call. GET = read, POST/PUT =
  write. No DELETE/send endpoints (blocked). Runs in the user's session via the extension.
- `browser_navigate / browser_observe / browser_screenshot / browser_input / browser_eval`
  - drive the live Zoho UI (composer, scheduler). Each currently goes through the queue.
- `list_skill_guides / read_skill_guide / save_skill_guide` - the workflow memory.

Guardrails (keep): never delete, never send-now (schedule only), org `890324941`, modules
Accounts/Contacts/Deals/Tasks, `crm.zoho.com` only. Enforced in `lib/agent/zoho-api.ts` and
`extension/src/send-guard.ts`.

### 1.4 How Snap (the reference) works, and why it's fast

- Snap runs its code tools **in-process** on its own machine, so a file read or API call
  returns in milliseconds with no queue in between.
- For work that must happen as the user, Snap does NOT run a browser in its sandbox. It
  drives the user's **real** browser on the user's device over a **live, direct channel** -
  send a command, get the result straight back. Same "real session" model as this
  extension. The difference is the channel is live, not a polled queue.
- Snap **batches reads and serializes only commits**: one rich look that returns everything
  the next few actions need, one bulk lookup per group of records, then individual verified
  commits. It does not do observe -> act -> observe -> act for every micro-step.

This migration copies those three properties into this agent. It does NOT move the browser
into a cloud sandbox (e.g. E2B) - that cannot hold the user's real Zoho login, so it does
not help. The fix is a live channel to the browser the user already has, plus fewer,
batched calls.

### 1.5 Why it is slow today (the diagnosis, measured from the code)

Two independent causes, both must be fixed:

**Cause 1 - the queue tax (transport).** Every `zoho_api` and `browser_*` call round-trips
through `tool_jobs` with polling on BOTH ends:
- Server side: `runBridgedTool` (`lib/agent/bridge.ts`) inserts a row, then polls it every
  `POLL_INTERVAL_MS = 500` until status flips to done/failed.
- Extension side: `extension/src/jobs.ts` claims via a 1500ms poll (`ACTIVE_POLL_MS`) plus
  an SSE pickup loop (`streamLoop`), executes, then reports via a separate HTTP POST to
  `/api/ext/jobs/{id}/report`.
- Net: each call pays ~0.5-2s of pure message-passing before/after real work. A 13-call
  task (see the user's screenshot) becomes 30-40s of waiting.

**Cause 2 - too many calls (behavior).** The agent resolves records one at a time (one
`zoho_api` search per contact/deal) and drives the UI in thin steps (navigate -> observe ->
input -> observe), plus retries on UI failures. A one-email task that should be ~10 calls
becomes 25+.

Fixing only one leaves it slow. Workstream B fixes Cause 1, Workstream A fixes Cause 2.

---

## PART 2 - The migration (ordered workstreams)

Do them in this order. Each must compile (`npx tsc --noEmit`) and pass `npm test` before the
next. Keep the extension, the `#token` API pattern, the mirror, and the guardrails intact
unless a step says otherwise.

### Workstream A - Make it BEHAVE like Snap (fewer, batched calls)

Highest value-for-effort; no infra change. Mostly prompt + a couple of tool ergonomics.

**A1. One bulk lookup per identity, not per record.**
- Prompt change in `AGENT_INSTRUCTIONS` (`loop.ts`): "Resolve a set of records in ONE
  `db_query`/`db_search_records` per module (or one `zoho_api` search with an `id`/criteria
  set), never one call per record. The mirror returns `zoho_url` and IDs; use them directly."
- Verify `db_query` (`lib/agent/tier0-tools.ts`) supports set/`in` filters; if it only does
  single-value equals, extend the filter schema to accept a list value so N records resolve
  in one call.

**A2. Batch observation, serialize commitment.**
- Prompt: "Before acting in the UI, do ONE rich read that returns everything the next few
  actions need (all recipient chips with their `email` attributes, subject, body/signature
  state, Cc/Bcc presence, the schedule control's position). Use `browser_eval` returning a
  JSON bundle for this. Do NOT run observe -> act -> observe for each micro-step. Only the
  committing actions (chip commit, Schedule, Schedule & Close) are done one at a time and
  verified individually."
- This is already partly in the prompt; make it the explicit default and mark repeated thin
  `browser_observe` calls as a smell.

**A3. Prefer the API over the UI whenever the data allows.**
- Prompt: "For anything expressible as data (field updates, tags, task create/complete,
  reads), use `zoho_api`, not the browser. Reserve `browser_*` for the email
  composer/scheduler and things only the UI can do. API calls are faster and fail less."

**A4. Batch read-backs.**
- After writes, verify with ONE `GET /crm/v3/{Module}?ids=...` for all touched records
  (union of fields), not one GET per record. `compareZohoApiReadBack` (`zoho-api.ts:147`)
  already supports comparison; ensure the loop's verification path issues a single batched
  GET. Grep for the read-back call site and make it batch.

**A5. Target and measure.**
- Add a per-turn counter already present (`toolCallCount`) to the final audit/report so runs
  are measurable. Target: a one-email-two-task run at 10-14 tool calls. Log the count.

Acceptance for A: the same one-email task that showed ~13+ calls in the screenshot now runs
in <=14 calls with no per-record search fan-out and no observe/act churn.

### Workstream B - Make the CHANNEL live like Snap (kill the polling)

This removes Cause 1. Goal: jobs are pushed to the extension the instant they're created,
and results are pushed back the instant they're done, with no polling on the hot path.

**Recommended approach: use Supabase Realtime (no new infra).** Supabase already backs this
app and supports Realtime subscriptions on Postgres changes and broadcast channels. This
gives push in both directions without standing up a separate WebSocket server (important
because the Next.js API routes are serverless-style and can't hold long-lived sockets well).

**B1. Server -> extension push (job delivery).**
- On `tool_jobs` INSERT, the extension should learn immediately. Have the extension open a
  Supabase Realtime subscription (using a scoped anon/JWT the server mints for the
  extension) to `postgres_changes` INSERT events on `tool_jobs` filtered by its `user_id`,
  OR to a broadcast channel the server publishes to right after insert.
- On event, the extension claims the job (keep the existing `/api/ext/jobs/claim` for the
  atomic claim to avoid double-run races) and executes. This keeps claim safety, removes
  the 1500ms poll from the hot path.

**B2. Extension -> server push (result delivery).**
- Keep the extension reporting to `/api/ext/jobs/{id}/report` (that write already exists and
  flips the row to done/failed).
- Change the SERVER wait: `runBridgedTool` (`bridge.ts`) must stop polling every 500ms.
  Instead, after inserting the job, subscribe to Supabase Realtime `postgres_changes` UPDATE
  on that specific `tool_jobs` row id and resolve the promise the moment status becomes
  done/failed. Keep a hard timeout (`agentJobTimeoutMs`) and keep a single reconciliation
  poll as a safety net for missed events, but the common path must be event-driven.

**B3. Keep the current poll + SSE as fallback, not primary.**
- Leave `pollOnce`/`streamLoop` (`jobs.ts`) as a low-frequency safety net (raise
  `ACTIVE_POLL_MS` since Realtime is primary). Do NOT delete them - they cover Realtime
  disconnects.

**B4. Alternative if Realtime is undesirable:** stand up a small dedicated WebSocket relay
service (not in the serverless app) that both the server and the extension connect to; the
server publishes new job ids and awaits result messages; the extension subscribes and posts
results. More infra, more control. Only choose this if Realtime limits (connection caps,
payload size) become a problem. Default to B1-B3.

Acceptance for B: measured round-trip for a single `zoho_api` GET (model-issues-call to
result-in-hand) drops from ~1-2s to well under 300ms on a warm connection; no code path on
the hot path sleeps on a fixed poll interval.

### Workstream C - Make it LEARN like Snap (teach -> distill -> repeat)

This is the "you teach it once, it makes a skill, then repeats" behavior, backed by
Supabase. Full file-level steps are in the companion brief
`IMPLEMENTATION_BRIEF_teach_distill_repeat.md`. Summary of what it does:

- **Teach mode** (already a real DB flag `agent_sessions.teach_mode`, toggled by
  `PATCH /api/agent/sessions/[id]` and the "Teach a workflow" button): rewire it so the
  agent does one real action per instruction with the GENERAL tools (`zoho_api`/`browser_*`),
  narrates, waits, and captures a transcript - NOT the old `ui_step`/`run_ui_workflow`
  replay path (delete that).
- **Distill**: when the user says "remember this"/task completes, the agent writes a
  `skill_guide` (intent, method as hints-to-confirm, gotchas, verification, stop conditions,
  and `params` for everything that varies). Rule: **guides store method, never data.**
- **Repeat**: when a task matches a guide, `read_skill_guide` it, resolve this run's records
  from the mirror in one lookup (Workstream A1), confirm live, run the method, verify. For
  batches: do #1 as a sample, then run the rest under budget + Stop.
- The mirror supplies the links/IDs per run; the guide supplies the steps. That is the merge
  the user asked for.

Follow the companion brief's Changes A, B, C, H, F, E, J for exact edits.

### Workstream D - Delete the legacy machinery (cleanup)

Do last, once A-C work. The loop's dispatch (`loop.ts ~2592-2745`) still executes
un-advertised legacy paths that compete with the agent-first model and carry the old
approval gates. Remove the dispatch branches and delete the files:
`lib/agent/task-orders.ts`, `lib/agent/tier2-tools.ts`, `lib/agent/tier2.ts`,
`lib/agent/ui-tools.ts`, `lib/agent/email-scheduling-tools.ts`, and
`tests/tier2-tools.test.ts`. Remove the `TASK_PREPARATION_FAILED` hard stop
(`loop.ts:2545-2549`) and the `approvals_enabled` gate branches. Leave the `task_orders` and
`pending_approvals` TABLES in place (non-destructive) but stop writing to them. Full list in
the companion brief, Change D. Re-expose `undo_record` to the model (Change F) and ensure
each `zoho_api` write stores a before-value.

---

## PART 3 - Sequence, acceptance, and scope

### 3.1 Recommended order

1. **Workstream A** (behavior) - biggest visible speedup, no infra risk. Ship first.
2. **Workstream B** (live channel) - removes the queue tax. Ship second.
3. **Workstream C** (teach/repeat) - per companion brief.
4. **Workstream D** (delete legacy + re-expose undo) - final cleanup.

After each workstream: `npx tsc --noEmit`, `npm test`, and one live smoke test of a
one-email-two-task run. Record the tool-call count and wall-clock time each time so the
improvement is measured, not assumed.

### 3.2 Global acceptance criteria (the definition of "moves like Snap")

1. A one-email-two-task run completes in <=14 tool calls (Workstream A) and under a few
   seconds of transport overhead (Workstream B), versus the current ~13+ calls at ~40s.
2. Record sets resolve in one mirror/API lookup per module; no per-record search fan-out.
3. UI work does one rich observation then serialized commits; no observe/act churn.
4. Data-expressible work goes through `zoho_api`, not the browser.
5. A task taught once is saved as a `skill_guide` and repeated by a fresh session with no
   re-teaching; guides contain method not data; the mirror supplies links per run.
6. No polling on the hot path; job delivery and result return are event-driven with a poll
   safety net only.
7. Legacy dispatch paths and files are gone; `tsc` and tests pass; undo is exposed.

### 3.3 Do NOT do

- Do not move the authenticated browser into a cloud sandbox (E2B or otherwise). The user's
  real Zoho session lives in their Chrome; a sandbox browser cannot hold it. E2B does not
  fix the bottleneck. The fix is the live channel (Workstream B), not relocation.
- Do not delete the extension, the mirror, the guardrails, or the `#token` API pattern.
- Do not drop the `task_orders`/`pending_approvals` tables in this pass (non-destructive).
- Do not embed run-specific data (record IDs, emails, dates, body text) into skill guides.

### 3.4 Files this migration touches

Edit: `lib/agent/loop.ts` (prompt, dispatch, verification batching, tool-call logging),
`lib/agent/bridge.ts` (event-driven wait), `lib/agent/tier0-tools.ts` (set filters in
`db_query`), `extension/src/jobs.ts` + `extension/src/api.ts` (Realtime subscription,
demote polling), `lib/agent/skill-guides.ts` + `lib/agent/guide-routing.ts` (Workstream C),
`AGENT_TOOL_DEFINITIONS` (expose undo). Possibly a server route to mint a scoped Supabase
Realtime token for the extension.
Delete (Workstream D): `lib/agent/task-orders.ts`, `lib/agent/tier2-tools.ts`,
`lib/agent/tier2.ts`, `lib/agent/ui-tools.ts`, `lib/agent/email-scheduling-tools.ts`,
`tests/tier2-tools.test.ts`.
Leave intact: `lib/records/mirror.ts`, `lib/agent/zoho-api.ts`, `extension/src/send-guard.ts`,
`lib/agent/undo-tools.ts` (re-expose, don't delete), all guardrail code.

---

## PART 4 - Quick reference for a fresh session

- Brain: `lib/agent/loop.ts`. Prompt lives in `AGENT_INSTRUCTIONS` there.
- Transport (to fix): `lib/agent/bridge.ts` (server wait) + `extension/src/jobs.ts` (client).
- Mirror (links): `lib/records/mirror.ts`, tools in `lib/agent/tier0-tools.ts`.
- Skills (memory): `lib/agent/skill-guides.ts`, table `supabase/2026_v2_phase_g.sql`.
- Live CRM: `lib/agent/zoho-api.ts` (allowlist + guardrails), executed via the extension.
- Build/test: `npx tsc --noEmit`, `npm test`, `npm run dev`.
- Companion detail for teach/repeat: `IMPLEMENTATION_BRIEF_teach_distill_repeat.md`.
