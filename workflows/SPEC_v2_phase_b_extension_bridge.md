# V2 Phase B Build Spec — Extension Tool Bridge + Live Zoho Reads

Version 1.0 (2026-07-06). For Codex. Prereq: Phase A merged and reviewed (chat + Tier-0 tools working against the mirror).
Read first: `workflows/SPEC_v2_tool_agent_migration.md` §2/§3/§6, `reference/ZOHO_SESSION_API_REFERENCE.md` (every Zoho call in this phase follows it exactly), `docs/V2_DECISIONS.md`, `docs/PHASE_3_DECISIONS.md` (the reviewed atomic-claim pattern — replicate it for tool_jobs).

## 0. Goal & boundary

The agent gains **live Zoho READS** through the Chrome extension: `zoho_search`, `zoho_get_record`, `zoho_get_related`, `zoho_read_api`. Acceptance scenario 1 must work end to end: "Get me the next step for the Duraco deal" → mirror search → live read → answer labeled live.

**Hard boundary: zero Zoho writes.** The extension job executor in this phase implements GET-only session-API calls. `db_sync_records` is Phase C; approval-gated writes are Phase D. No UI automation (Phase F).

## 1. Backend — job bridge

### Routes (token auth via existing `requireExtensionAuth`)

- `POST /api/ext/jobs/claim` — claims the oldest `queued` tool_job for the token user. **Atomic**: UPDATE guarded on `status='queued'`, `.maybeSingle()`; zero rows = lost race → `{ job: null, lost_race: true }`. Also sweeps this user's `queued` jobs older than 10 min to `expired` and `running` jobs claimed >5 min ago to `failed` ("extension went away mid-job") before claiming. Response: `{ job: { id, tool_name, args }, context: { org_id, crm_domain } }` or `{ job: null }`.
- `POST /api/ext/jobs/[id]/report` — body `{ result }` or `{ error_message }`. Only the claiming user's job, only from `running`; sets `done`/`failed` + `completed_at`. A special `error_code: "zoho_logged_out"` is stored verbatim (the waiting tool surfaces it as user guidance). Audit `ext_job_reported`.
- Extend `POST /api/ext/handshake` response with `{ queued_jobs: n }` so the options page can show pending work.

### Loop integration (`lib/agent/bridge.ts`)

`runBridgedTool({ service, user, sessionId, call, timeoutMs })`:
1. Preflight: extension liveness = `user_extension_tokens.last_seen_at` within 60 s. If not live → return a tool error result immediately: `"The Chrome extension is not connected. Open a crm.zoho.com tab and enable the extension, then ask again."` (no queued zombie jobs when nothing is polling).
2. Insert `tool_jobs` row (service client; `user_id`, `session_id`, tool, args).
3. Poll the row every 500 ms until `done`/`failed`/timeout (default 90 s). Timeout → mark job `expired`, return tool error.
4. `done` → return `result` (truncate via the existing loop cap). `failed` → tool error with `error_message`; `zoho_logged_out` gets the friendly "log back into Zoho" phrasing.

The loop (`lib/agent/loop.ts`) routes tool calls: Tier-0 → in-process; Tier-1 names → `runBridgedTool`. Emit `tool_call` immediately (so the UI shows the spinner while the job waits) and a `tool_status` SSE event `{queued|running}` when the job's status changes.

## 2. Tier-1 tool definitions (`lib/agent/tier1-tools.ts`)

Zod + JSON schema for each (same double-validation pattern as tier0):

- `zoho_search { module: Accounts|Contacts|Deals, criteria?: string, name?: string, tag?: string, page?: int≥1 }` — exactly one of criteria/name/tag. `name` builds the proven fallback (exact criteria → starts_with clean prefix; special chars stripped per reference). Returns `{ records: [...], more_records: bool, page }`.
- `zoho_get_record { module, zoho_id, fields: string[] (1–30) }` — fields validated against `zoho_field_meta` for the module (server-side, BEFORE queueing).
- `zoho_get_related { account_zoho_id, child: Contacts|Deals, page? }`.
- `zoho_read_api { path, params? }` — the escape hatch. Server-side allowlist (regex, anchored): `^/crm/v3/(Accounts|Contacts|Deals)(/[A-Za-z0-9]+)?(/(Contacts|Deals))?$`, `^/crm/v3/(Accounts|Contacts|Deals)/search$`, `^/crm/v3/settings/fields$`, `^/crm/v3/users$`. Anything else → tool error WITHOUT queueing. Params: plain string map, max 8 keys.

Agent instructions update: prefer live reads for single-record questions, the mirror for aggregates/lists; ALWAYS label which source an answer came from; if the extension is offline, say so and offer the mirror answer instead.

## 3. Extension — job executor

- **Finish `extension/src/zoho-api.ts` (GET surface only this phase):** header builder from the live page (`#token` → `X-ZCSRF-TOKEN: crmcsrfparam=...`, `X-CRM-ORG: 890324941`, `X-Requested-With: XMLHttpRequest`, `credentials:'include'`); `searchRecords`, `getRecord`, `getRelated`, `rawGet(path, params)`; HTTP 204 → `{ records: [] }`; 400 INVALID_QUERY on criteria → retry once with starts_with fallback; pagination passthrough (`info.more_records`); 15 s AbortController timeout per call; logged-out detection (missing `#token` / 401 / redirect) → report `error_code: "zoho_logged_out"`.
- **`extension/src/jobs.ts`:** poll `/api/ext/jobs/claim` every 1.5 s while (options toggle enabled) AND (a crm.zoho.com tab exists); back off to 15 s after 5 idle minutes, snap back on any activity. Claimed job → send to the content script in the CRM tab → execute the mapped GET → report. Unknown tool_name → report failed "tool not supported by this extension version". One job in flight at a time.
- **Options page:** show queued-jobs count from handshake + last job status line. The existing enable toggle covers jobs too — one switch, clearly labeled "Allow the agent to use this browser's Zoho session (read-only in this version)".
- Keep the Phase 3 run-items dry-poll code untouched; jobs and run items remain separate queues.

## 4. Transcript upgrade (do this FIRST — it unblocks reliable multi-step loops)

Replace the Phase A flattened-text transcript with **item-based Responses input** in both providers' `runTools`:
- user/assistant text → `{type:"message", role, content:[...]}` items;
- assistant tool calls → `{type:"function_call", call_id, name, arguments}` items;
- tool results → `{type:"function_call_output", call_id, output}` items.
Mirror pi's `openai-codex-responses.ts` for the Codex dialect's exact item shapes. `AgentPromptMessage` gains `callId`; the loop persists `call_id` in `agent_messages.tool_args._call_id` (or a new column — prefer a `tool_call_id text` column added in `2026_v2_agent.sql`, it's still unrun... **check with Aryan**: if he already ran it, ship a tiny `2026_v2_phase_b.sql` instead). Keep the flattening function as a fallback behind `AGENT_FLAT_TRANSCRIPT=1` for one release in case a provider rejects item form — remove in Phase C.

## 5. Build order (each step runnable)

1. Transcript upgrade (§4) + prove Phase A scenarios still pass.
2. Migration delta if needed (`tool_call_id`); jobs claim/report routes with atomicity + sweeps; curl-test against hand-inserted jobs.
3. `lib/agent/bridge.ts` + loop routing + `tool_status` SSE + offline preflight. Test with a fake job manually flipped to `done` in the DB.
4. Tier-1 tool definitions + allowlist + field validation; loop exposes them; agent can queue jobs (which fail pending extension work — visible in chat as friendly errors).
5. `zoho-api.ts` GET surface + `jobs.ts` in the extension; `npm run build:extension`; live test: Aryan asks the Duraco question with the extension enabled.
6. Negative tests: extension disabled (friendly offline answer); non-allowlisted `zoho_read_api` path (blocked without queueing); logged-out Zoho (guidance message); job timeout (expired + clean chat error).

## 6. Done-when

- Scenario 1 live end to end, with the tool trace showing mirror search → live `zoho_get_record`, answer labeled live.
- All §5.6 negative paths behave as described — no hangs, no silent failures, no zombie jobs left `queued`/`running`.
- Extension executor contains no non-GET call path (grep-provable: no `PUT`/`POST` to crm.zoho.com in `jobs.ts`/`zoho-api.ts` GET surface — the write functions from Phase 3's spec stay unimplemented or clearly unexported this phase).
- `typecheck` / `lint` / `build` / `build:extension` green; orchestrator tests still 7/7; V2_DECISIONS updated per checkpoint.
- Chat review gate: expect scrutiny on claim atomicity, sweep correctness, the allowlist regex, and transcript item pairing (call_id round-trip).

## 7. Carried invariants

JSON errors with `[tag]` logs; timeouts on every fetch (server AND extension); fail-before-side-effects (allowlist/field checks before queueing); extension is untrusted input — server validates args before queueing and never trusts reported results beyond storing them as evidence; same-user enforcement on every job route; commits authored as Aryan Dhamani (dhamaniaryan4@gmail.com), no AI co-author; exact version pins.
