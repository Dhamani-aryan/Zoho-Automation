# V2 Migration Spec — Tool-Calling Agent

Version 1.1 (2026-07-05). For Codex. Supersedes the parse→validate pipeline as the PRIMARY user experience; that pipeline is retained for batch preset runs (see §9).
v1.1 adds: §3b (UI navigation + teachable, self-recorded workflows — Aryan's requirement), §13 (reference implementations incl. Vercel's open-agents patterns), Phase F.

**Multi-tool by design:** the agent has the full toolbox of §3 + §3b (15+ independent tools across tiers) and chooses freely per query — DB search vs live Zoho read vs sync vs gated write vs UI workflow. Tool choice is the model's job; tool EXECUTION is always deterministic code.
Decision by: Aryan Dhamani, 2026-07-05, after testing the Phase 2 pipeline.
Read first: `ZOHO_AGENT_WORK_PLAN.md` §2–3 (environment facts still bind), `reference/ZOHO_SESSION_API_REFERENCE.md`, `workflows/SPEC_phase3_extension_live_execution.md` (its infrastructure is REUSED, not discarded), `zoho-agent/docs/PHASE_2_DECISIONS.md` + `PHASE_3_DECISIONS.md` (binding engineering invariants).

## 0. The decision and what it changes

V1: LLM produces a one-shot plan; deterministic code validates and executes. V2: the LLM runs an **agentic tool-calling loop** — it receives the user's message, decides which tools to call (search the DB, read Zoho live through the extension, sync records into the DB), observes results, iterates, and answers. The user watches the tool trace live in a chat UI.

**What is kept, non-negotiable (Aryan's own product rules from the work plan §2/§6):**
- **CRM writes always require explicit human approval before executing.** Reads and local-DB syncs do not.
- No deletes, no record creation in Zoho, org `890324941` on crm.zoho.com only, modules Deals/Contacts/Accounts only.
- The extension executes only its own user's work; no Zoho passwords stored; per-user LLM credentials (existing encrypted storage, reused as-is).
- Every action audited; every Zoho write verified by read-back; JSON errors with real reasons; timeouts on all upstream calls; fail before side effects on config errors.

**What is dropped as the primary UX:** the command → parse → validate → preview form (`/run/new`). It remains for batch preset workflows (§9) but the default surface becomes the agent chat.

**Explicitly deferred (discussed and agreed):** the agent authoring its own tools at runtime. Instead: a fixed, fast-growing toolbox + `zoho_read_api` (generic allowlisted GET) + a `request_new_tool` meta-tool that files a structured request for Codex to implement. Revisit only after v2 is stable.

## 1. Target experience (the acceptance scenarios)

1. **Live field lookup.** "Get me the next step for the Duraco deal." → agent calls `db_search_records(deals, "duraco")` → 1 match → calls `zoho_get_record(Deals, <id>, [Next_Step, Stage, Owner])` via the extension → answers "Next Step on *Duraco … | SAP Cloud ERP* is **2nd Email** (live from Zoho just now)" → offers to update the local mirror if it drifted.
2. **Tag-driven sync.** "I added new accounts in Zoho with tag Q3 Prospects — pull them in." → agent calls `zoho_search_by_tag(Accounts, "Q3 Prospects")` → pages through results → calls `db_sync_records(accounts, rows)` → answers "Found 12 accounts with that tag; 9 were new, 3 updated. Mirror is current." Every inserted/updated row listed.
3. **Gated write.** "Set Next Step to 3rd Email on the Duraco deal." → agent resolves the record, then calls `zoho_update_fields` — which does NOT execute: it returns a pending approval the chat renders as an Approve/Reject card (record, field, before → after). On Approve, the write executes through the extension, is verified by read-back, and the agent confirms. On Reject, the agent is told and continues.
4. **Missing capability.** "Merge these two duplicate accounts." → no tool exists → agent says so and calls `request_new_tool` with a structured description; the request lands in the DB for review. It never improvises around a missing tool.

## 2. Architecture

```
Chat UI (/agent)                Backend (Next.js)                     Chrome extension
────────────────                ─────────────────                     ────────────────
message ──────────────────▶ agent loop runner
                            LLM (user's credential, tool defs)
                            ├─ DB tools: execute in-process
                            ├─ Zoho tools: enqueue tool_job ────────▶ fast poll (1–2 s while active)
                            │                                        execute via session API in CRM tab
                            │   result ◀──────────────────────────── report tool_job result
                            ├─ write tools: create pending_approval
                            │   ── chat renders Approve card ──▶ user
                            │   approved → enqueue tool_job → extension → verify → result
                            └─ final answer streamed to chat
Everything (messages, tool calls, args, results, approvals) persisted + audited.
```

- **Loop runner** lives server-side (`lib/agent/loop.ts`). One turn = repeated LLM ↔ tool exchanges until the model returns a final message or a budget trips (§8). The LLM uses the existing per-user credential via the existing `LLMProvider` layer, extended with tool-calling support (§5).
- **Tool bridge**: Zoho tools cannot run on the server (session lives in the browser). They become rows in `tool_jobs`; the extension polls, executes with the already-built session-API client (Phase 3 `extension/src/zoho-api.ts` — finish it per the Phase 3 spec §4, it is the workhorse here), and reports results; the loop resumes. Poll cadence: 1–2 s while the options toggle is enabled and a CRM tab exists (chrome.alarms minimum is too coarse — use setInterval in the service worker kept alive by the poll, falling back to alarms).
- **Tool tiers**:
  - **Tier 0 — free:** local DB reads. Execute immediately in-process.
  - **Tier 1 — auto, logged:** Zoho READS via extension; local-DB mirror upserts (`db_sync_records`). No approval; every call audited.
  - **Tier 2 — gated:** Zoho WRITES (`zoho_update_fields`, `zoho_change_owner`, `zoho_add_tags`, `zoho_remove_tags`). Tool execution blocks until the user approves in chat. Approval is per tool call; a batch write in one call = one approval showing all records.

## 3. Toolbox v1 (contracts)

All tool args are Zod-validated server-side before execution — the model is never trusted to respect its own schema. All results are truncated to a size cap (~8 KB per result; larger sets return counts + first N + a cursor).

**Tier 0 — DB (in-process, user-scoped Supabase client so RLS applies):**
- `db_search_records { module, query, limit? }` — the v1 resolver logic as a tool: exact → starts_with → contains → token match, deals searchable by account name, returns matches + near-misses.
- `db_get_record { module, id_or_zoho_id }` — full mirror row incl. raw_data.
- `db_list_by_tag { module, tag }` / `db_list_tags { module }`.
- `db_query { module, filters: [{field, op, value}], limit }` — simple structured filters only, no raw SQL. Ever.

**Tier 1 — Zoho reads (extension bridge) + mirror sync:**
- `zoho_search { module, criteria | tag | name, page? }` — session-API search with the proven fallbacks (204 = none, special chars → starts_with + client filter, paginate via info.more_records).
- `zoho_get_record { module, zoho_id, fields[] }`.
- `zoho_get_related { account_zoho_id, child: "Contacts" | "Deals" }`.
- `zoho_read_api { path, params }` — generic **GET-only** escape hatch; path must match an allowlist (`/crm/v3/{Modules}/...`, `/crm/v3/settings/fields`, `/crm/v3/users`). 405 anything else. This is the flexibility valve that makes runtime tool-authoring unnecessary.
- `db_sync_records { module, records[] }` — upsert Zoho rows into the mirror using the EXISTING import upsert logic (`scripts/import-masters.mjs` extraction → shared lib). Returns {inserted, updated, unchanged} with names. This is a LOCAL write, Tier 1 by Aryan's decision — it never touches Zoho.

**Tier 2 — Zoho writes (approval-gated, then extension bridge, then verify):**
- `zoho_update_fields { module, updates: [{zoho_id, fields: {api_name: value}}] }` — chunk ≤100; picklist/email/date validation server-side BEFORE the approval card is shown (reuse `lib/plan/validation.ts` rule functions); identity check + read-back verify in the extension per Phase 3 spec §4; before/after in the result.
- `zoho_change_owner { module, zoho_ids[], owner_name }` — owner resolved server-side against known users.
- `zoho_add_tags` / `zoho_remove_tags { module, zoho_ids[], tags[] }`.
- Stage edits remain admin-only (server-enforced); `Deal_Name` edits blocked in v2.0.

**Meta:**
- `request_new_tool { name, purpose, example_call }` — inserts into `tool_requests`; the agent tells the user it filed the request.

## 3b. UI navigation + teachable workflows (v1.1)

Requirement (Aryan): the agent must be able to navigate the Zoho UI for things the API can't do, be TAUGHT a navigation flow once ("do this, then that"), record it, and replay it on its own afterwards — no re-teaching.

**UI step vocabulary** (executed by the extension content script; superset of the Phase 3/4 vocabulary, selectors seeded from KD Blitz spec §9):
`open_url`, `wait_for {selector|text, timeout}`, `click {selector|text}`, `fill_field {selector, value}`, `read_field {selector}`, `press_key {key}`, `confirm_text_present {text}`, `verify_field {selector, equals}`, `screenshot`. Synthesized mouse events + real Enter keypresses where Zoho needs them (known from the playbooks). Every step returns ok/fail + evidence; fail stops the workflow.

**Storage** (add to the §4 migration):
```sql
create table public.ui_workflows (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.users(id) on delete set null,
  name text not null unique,
  description text,
  params jsonb not null default '[]'::jsonb,   -- [{name, description, example}]
  steps jsonb not null,                         -- ordered step list; literals replaced by {param} slots
  effect text not null default 'read' check (effect in ('read','write')),
  trusted boolean not null default false,       -- becomes true only after a verified test replay
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**Teaching — two modes, both explicit (never ambient):**
1. **Guided teaching in chat.** User starts "teach mode" and narrates: "open the deal → click Open Activities → …". For each instruction the agent emits ONE `ui_step` tool call (teaching-mode-only tool), the extension executes it live in the user's Zoho tab, the user watches and corrects. The verified step sequence accumulates; at the end the agent calls `save_ui_workflow {name, description, steps, params, effect}` — proposing parameter slots for the literals that will vary (record URL, values, dates) and effect=read|write. The user confirms the save in a card.
2. **Demonstration recording.** Extension options page gains "Record workflow": the content script captures the user's own clicks/inputs on crm.zoho.com into step candidates (selector, action, value). User stops recording and names it; the agent reviews the raw capture, proposes cleaned/parameterized steps, user confirms the save. (Recorder captures NO passwords; recording only on crm.zoho.com; raw captures discarded after save.)

**Replay:** `run_ui_workflow {name, params}` + `list_ui_workflows {}`. Tier by declared `effect`: read replays are Tier 1; write-effect replays (anything changing CRM state, incl. scheduling email or completing tasks) are Tier 2 — approval card first, always, even though the workflow was taught by the same user. First replay after save runs as a supervised "test replay"; only a fully verified test replay sets `trusted=true`, and untrusted workflows warn in the card. Each step verifies before the next; failure stops, screenshots as evidence, run reported like any tool result.

This is how the KD Blitz UI actions (Phase 4 scope: compose/schedule email, task create/complete) eventually land: taught once as ui_workflows instead of hand-coded selectors — with the §9 batch pipeline able to call the same saved workflows later (v2.1).

## 4. Database migration (`supabase/2026_v2_agent.sql`)

```sql
create table public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text,
  status text not null default 'active',      -- active | archived
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text,                                 -- user/assistant text
  tool_name text,                               -- tool messages
  tool_args jsonb,
  tool_result jsonb,
  tool_tier int,
  created_at timestamptz not null default now()
);

create table public.tool_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  tool_name text not null,
  args jsonb not null,
  status text not null default 'queued',        -- queued | running | done | failed | expired
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz
);

create table public.pending_approvals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  tool_name text not null,
  args jsonb not null,
  summary jsonb not null,                       -- per-record before/after for the card
  status text not null default 'pending',       -- pending | approved | rejected | expired
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.tool_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  name text not null,
  purpose text not null,
  example_call jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
-- RLS on all five: owner reads own rows (admin all); writes via server routes.
-- Approvals expire after 15 minutes unapproved; jobs expire after 10 minutes unclaimed.
```

## 5. Backend

- `POST /api/agent/sessions` / `GET /api/agent/sessions/:id` — create/fetch a chat.
- `POST /api/agent/sessions/:id/messages` — user message in; runs the loop; streams events out (SSE: `assistant_delta`, `tool_call`, `tool_result`, `approval_required`, `done`, `error`).
- `POST /api/agent/approvals/:id` — body `{ decision: "approve" | "reject" }`. On approve: enqueue the Tier-2 `tool_job`; the paused loop turn resumes when the job reports (or the loop re-invokes the model with the result on next message if the turn already ended — implement resume-on-report first, simpler: the turn WAITS up to 5 min for approval+execution, then times out into a resumable state).
- `LLMProvider` extension: add `runTools(input, tools, onToolCall) `— Responses API function-calling for BOTH providers. Codex path: mirror how pi's `openai-codex-responses` api sends `tools` and parses `function_call` items from the SSE stream (same file already referenced for streaming; small header/shape diffs cause 403s — copy exactly). API-key path: standard Responses API `tools`.
- Extension bridge routes (extend the Phase 3 namespace, same token auth):
  - `POST /api/ext/jobs/claim` — next queued `tool_job` for this user (atomic claim, status guard — same pattern as the reviewed run-items claim).
  - `POST /api/ext/jobs/:id/report` — `{ result | error_message }`; wakes the waiting loop.
- The loop runner enforces budgets (§8), persists every step to `agent_messages`, audits to `audit_events` (`agent_turn`, `tool_call`, `approval_decided`).

## 6. Extension changes (delta on the Phase 3 skeleton)

1. Finish `zoho-api.ts` per Phase 3 spec §4 (headers from `#token`, search/read/update/tags/verify, ≤100 chunks, 204 handling, logged-out detection). This was already required for Phase 3 — it is the same code.
2. Add `jobs.ts`: fast poll loop (1–2 s interval while enabled + CRM tab present; back off to 15 s when idle 5+ min), claim → execute → report. Tool→executor map: search/get/related/read_api → session-API GETs; update/owner/tags → writes with identity check + read-back verify (identical sequence to Phase 3 §4).
3. Options page: unchanged pairing; add "agent jobs" on/off toggle + last-job status line.
4. The dry-poll run executor from Phase 3 step 5 stays for batch runs (§9); jobs and run-items are separate queues.

## 7. Chat UI (`app/agent/page.tsx` + components)

- Session list + chat pane. Streamed assistant text; collapsible tool-call rows (name, args, result summary, duration, tier badge); Tier-2 approval cards with per-record before → after table and Approve / Reject buttons; "extension offline" banner when Zoho tools are queued but nothing is polling (last_seen stale).
- Make `/agent` the default post-login landing. Keep nav links to Records / Imports / Runs / Settings.

## 8. Safety, budgets, guardrails (binding)

1. Tier-2 tools NEVER execute without an explicit approval row flipped to `approved` by the run's own user (server-checked). The approval card shows exactly what will change; what executes is exactly the approved args (immutable snapshot in `pending_approvals.args`).
2. Loop budgets per turn: max 15 tool calls, max 3 minutes wall clock, max ~100k input tokens cumulative; on trip → the agent stops and reports what it has. No background/scheduled agent turns in v2.0.
3. Tool args Zod-validated; modules/fields validated against `zoho_field_meta`; unknown tool names from the model → error result fed back to the model (never executed).
4. `db_query` takes structured filters only. No raw SQL tool. No filesystem tool. No arbitrary code execution tool — this is why runtime tool-authoring is out.
5. All Phase 2/3 error invariants apply (JSON errors, `[tag]` console.error, timeouts on every fetch, fail-before-side-effects, extension untrusted → server revalidates Tier-2 results by requiring verify evidence).
6. Concurrency: one active agent turn per session; tool_jobs claimed atomically; Tier-2 execution is sequential within a turn.
7. Mirror-drift honesty: answers sourced from the DB mirror are labeled "as of last sync"; live Zoho answers labeled live. The agent is instructed to prefer live reads for single-record questions and the mirror for aggregate/list questions.

## 9. What happens to the v1 pipeline

- **Kept:** the whole run/preview/approve/execute machinery (Phase 2 + Phase 3 steps 1–5, including the reviewed claim/report routes) for BATCH preset workflows — KD Blitz and book-of-business remain runs with full previews. The agent gets a `create_batch_run { command, files? }` tool later (v2.1) so chat can hand off big batches to the proven pipeline.
- **Kept:** Records browser, Imports, Field Meta, Settings, credentials, extension pairing.
- **Demoted:** `/run/new` free-text form — remove from primary nav once §10 Phase C passes; keep the route.
- **Dead:** nothing deleted in the migration. No table drops.

## 10. Migration phases (each runnable; live logging to docs/V2_DECISIONS.md, same style as Phase 2/3)

- **Phase A — agent core, DB tools only.** Migration SQL; loop runner with budgets; both LLM providers doing tool calling; chat UI with streaming + tool trace; Tier-0 tools. Done when: "get me the next step for the duraco deal" answers from the mirror (labeled as-of-sync) with a visible tool trace, and scenario 4 files a tool request.
- **Phase B — extension bridge + live reads.** tool_jobs + claim/report; fast poll; Tier-1 Zoho read tools; `zoho-api.ts` finished. Done when: scenario 1 runs end to end live (DB search → live Zoho read → answer) with the extension trace visible.
- **Phase C — sync.** `db_sync_records` + shared upsert lib. Done when: scenario 2 (tag → fetch → upsert → report counts) passes against a real tag Aryan creates, and the Records browser shows the new rows.
- **Phase D — gated writes.** pending_approvals + chat cards + Tier-2 tools with server-side validation, identity check, read-back verify. Done when: scenario 3 passes on a demo deal — including a rejection path and a verify-failure path — and nothing writes without the card.
- **Phase E — hardening + rollout.** Budgets tuned, approval/job expiry sweeps, transcript retention, admin audit view of agent activity, `/agent` as landing page, user guide update. Done when: a full day of Aryan's real usage produces zero unexplained failures.
- **Phase F — UI navigation + teachable workflows (§3b).** UI step executor in the extension; teach mode (guided) first, then the demonstration recorder; `ui_workflows` storage; `run_ui_workflow`/`list_ui_workflows`/`save_ui_workflow` tools; trusted-after-test-replay rule. Done when: Aryan teaches one real read workflow (e.g. "open a deal and read its Open Activities") once, and the agent replays it unaided on a different record; and one write-effect workflow replays only through an approval card.

## 11. Risks (accepted by this decision, with mitigations)

| Risk | Mitigation |
|---|---|
| Per-step LLM latency/cost on multi-step tasks | budgets; mirror-first for aggregates; result truncation |
| Non-deterministic tool choices between runs | full tool trace visible; audit log; Tier-2 gate makes variance harmless for writes |
| Extension offline mid-turn | queued jobs + offline banner; jobs expire cleanly; turn resumable |
| Model floods writes | one approval card per Tier-2 call; sequential execution; no approval = no write, server-side |
| Codex endpoint drift (models/protocol) | model id + endpoint in env; verbatim error surfacing (learned 2026-07-05) |
| Taught UI workflows break when Zoho's UI changes | per-step verify + stop; screenshots as evidence; workflows versioned; re-teach updates the version; API-first rule stands — UI workflows only for what the API can't do |

## 12. Reference implementations (study, don't fork)

- **Vercel `open-agents`** (github.com/vercel-labs/open-agents; template page: vercel.com/templates/next.js/open-agents) — a background *coding*-agent platform, so most of it (Vercel sandboxes, GitHub App, PR automation) does NOT apply. Copy these patterns:
  1. **"The agent is not the sandbox."** Their agent runs outside the execution VM and acts only through tools. Ours is identical with the browser in the VM's role: the loop runs on the server; the extension is a dumb executor. Never move agent logic into the extension.
  2. **Durable turns.** Chat requests start a workflow run rather than executing inline; runs survive the request lifecycle and streams can reconnect. That is exactly what our approval-wait needs (a Tier-2 card may sit for minutes). Implement turns as resumable DB-backed state (`agent_messages` + turn status), not as one long-lived HTTP request; the SSE stream reconnects to an in-flight turn. (On Vercel later, this maps to the Workflow SDK; locally a simple turn-state table + resume-on-report is enough.)
  3. Their chat/streaming UI structure (streamed deltas + typed tool events) — mirror with the AI SDK's `useChat`/streaming helpers if convenient, but keep our custom `LLMProvider` for the model calls (per-user Codex credential; AI SDK's providers don't speak the Codex backend's dialect — learned the hard way on 2026-07-05).
- **pi (`earendil-works/pi`)** stays the protocol reference for the Codex backend (tool/function-call items in the Responses SSE stream — `packages/ai/src/api/openai-codex-responses.ts`).

## 13. Working agreements (unchanged)

Codex builds phase by phase in order; each phase proven on real data before the next; decisions + fixes logged to `docs/V2_DECISIONS.md` as they happen; the chat reviews each phase (expect an atomicity/race review on claim paths — it found real bugs in Phase 3); commits authored as Aryan Dhamani (dhamaniaryan4@gmail.com), no AI co-author; exact-version dependency pins; `npm run typecheck && lint && build` green at every phase end.
