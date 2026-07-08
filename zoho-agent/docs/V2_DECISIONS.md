# V2 Decisions

## Agent search resolution: interpret loose wording, fall back before giving up (2026-07-08, chat)

Follow-on from the zoho_search fix below, same live session. Aryan asked for "the deal with the tag test search"; the agent searched the literal tag "test search", got zero results, and stopped - the real tag was "test". The tool worked once fixed; the gap was in the agent's instructions, which never told it to treat the user's wording as approximate intent or to do anything after an empty search besides report "not found".

Fix (lib/agent/loop.ts AGENT_INSTRUCTIONS only - no code or tool-surface change): added two directives. (1) Treat wording as intent, not exact values - a phrase like "the tag test search" may mean the tag is "test", or a name/field match; infer and try. (2) On an empty search, do not stop after one attempt: retry with broader/alternative terms or a different approach (tag vs name vs criteria), use db_list_tags / db_list_by_tag / db_search_records to discover what actually exists and pick the closest, and only then, if still no confident match, say what was tried and offer closest candidates or ask one short question. Stays within the existing tool-call budget.

Verified: npx tsc --noEmit clean. Same deploy note as the fix below - restart the server so the new instructions take effect; no extension rebuild.

NOTE (process): both edits to this file and to loop.ts were first attempted with the inline edit tool, which truncated the files on writes containing non-ASCII characters (em-dashes, arrows, ellipsis). Recovered from git and rewritten as ASCII via script. Prefer ASCII in these files.

## Phase B defect fix: zoho_search rejected valid tag-only lookups (2026-07-08, chat)

Symptom (Aryan, live): "find the deal tagged test search" → `zoho_search` failed validation repeatedly, alternating between two errors — `criteria`/`name` "Too small: expected string to have >=1 characters", and "zoho_search requires exactly one of criteria, name, or tag." The agent correctly refused to improvise and filed tool request `zoho_search_optional_fields_fix` (`daa578fe-…`).

Root cause (two, in `lib/agent/tier1-tools.ts`):
1. The JSON schema exposed to the model had `criteria`/`name`/`tag` as three bare `{type:"string"}` fields with no descriptions and no expression of the "exactly one of" rule, so the model couldn't discover the correct shape. A clean `{module, tag}` call DID pass — the model just never produced one.
2. The Zod schema hard-failed on empty strings (`.trim().min(1)`), so the model's common habit of sending `""` for unused fields tripped `min(1)` (error shape 1); swinging to zero/two provided fields tripped the refine (error shape 2). This is the same "omit unused keys, never send empty strings" lesson from Phase 2 that hadn't been applied to the Tier-1 schema.

Fix: `criteria`/`name`/`tag` now go through an `optionalSearchTerm` preprocess that maps empty/whitespace-only strings to `undefined` (so they count as omitted, not invalid); the refine message now tells the model to provide one and omit the others; and the tool description + each field's JSON-schema `description` now state the one-of rule and how to search by tag. No behavior change for valid calls; invalid calls get one clear, actionable error instead of two confusing ones.

Verified: `npx tsc --noEmit` clean. Still needs on the dev machine: `npm run lint && npm run build`, then redeploy/restart so the running `/agent` picks up the new tool schema (the model only sees the change after the server reloads). No extension rebuild needed (server-side only). Tool request `zoho_search_optional_fields_fix` can be closed once confirmed live. Suggested follow-up: a unit test asserting `{module,tag}` parses and `{module,criteria:"",name:"",tag:"x"}` normalizes to a tag-only search.

## Phase C review (2026-07-08, chat review)

Verdict: approved, one defect fixed. Verified independently: tsc clean, records tests 5/5 + orchestrator 7/7, spec-conformant (in-process db_sync_records; Zod before service client; FK resolution with warnings; stable-stringify change detection incl. raw_data; 200-cap; capped-names result; `mirror_sync` audit; CSV-mapper divergence documented; pagination guidance in prompt; still zero Zoho writes).

Defect fixed (`lib/records/zoho-upsert.ts`): duplicate zoho ids within one batch (possible via paginated zoho_search overlap) hit Postgres "ON CONFLICT DO UPDATE command cannot affect row a second time" and failed the whole sync. Records now deduped by id (keep last) with a warning; invalid id-less rows still reach assertRecord for a clear error.

Remaining before Phase D: Aryan runs the live scenario-2 test (fresh tag on 2–3 demo accounts → sync → re-run shows all-unchanged).

Confirmed on 2026-07-06.

1. V2 primary UX is a server-side tool-calling chat agent. The Phase 2 parse/validate/run pipeline remains for batch preset workflows.
2. Phase A is limited to the agent core and Tier-0 local database tools. It must make no Zoho calls and no CRM writes.
3. The Phase 3 extension bridge remains the execution model for later Zoho tools. The extension stays a dumb executor; agent logic stays on the server.
4. The migration is additive and idempotent. It creates the full v2 table set early (`agent_sessions`, `agent_messages`, `tool_jobs`, `pending_approvals`, `tool_requests`, and `ui_workflows`) so later phases do not need destructive schema changes.
5. `tool_jobs` and `pending_approvals` are readable by their owning user through RLS, but writes are reserved for server routes using the service-role client after explicit session/role checks.

## Phase A Start

The binding engineering invariants from Phase 2 and Phase 3 carry forward:

- API routes return JSON errors with tagged server logs.
- Upstream LLM fetches must have explicit timeouts.
- Configuration checks fail before side-effecting upstream calls.
- Client fetch handlers must clean up loading state.
- Unknown model tool names are never executed; they become tool error observations fed back to the model.
- Agent turns have budgets: max 15 tool calls and max 3 minutes wall clock.

External references checked before implementation:

- `earendil-works/pi` `openai-codex-responses.ts`: Codex Responses streams tool calls through output-item and function-call-arguments SSE events.
- `vercel-labs/open-agents`: keep the agent outside the executor and persist the turn transcript so execution can become durable in later phases.

## Phase A Checkpoint: Tier-0 Tools + Provider Tool Calls

Extracted shared local-mirror search code into `lib/records/mirror.ts` so Phase 2 preview resolution and the new agent DB tools use the same exact matching order: exact -> starts_with -> contains -> token match, with deal account-name search included.

Added Tier-0 tool definitions/execution in `lib/agent/tier0-tools.ts`: `db_search_records`, `db_get_record`, `db_list_by_tag`, `db_list_tags`, `db_query`, and `request_new_tool`. Tool args are Zod-validated before execution, `db_query` accepts structured filters only, and all data comes from the user-scoped Supabase client so RLS applies.

Extended `LLMProvider` with `runTools()`. The OpenAI API-key provider uses standard Responses function tools with a 90s timeout. The Codex provider keeps the known header/body quirks and now extracts function calls from both `response.completed` output and streamed `response.function_call_arguments.*` events.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.

## Phase B Checkpoint: Extension Job Claim/Report Routes

Added the read-tool job bridge routes under `/api/ext/jobs/*`. `POST /api/ext/jobs/claim` uses the existing extension bearer-token auth, sweeps this user's stale queued/running jobs, then claims the oldest queued job with a guarded `status='queued'` update so concurrent polls lose cleanly. `POST /api/ext/jobs/[id]/report` only finalizes the claiming user's `running` job, stores `done`/`failed`, preserves `zoho_logged_out` as an error code in the result payload, and audits `ext_job_reported`.

Extended `/api/ext/handshake` with `queued_jobs` so the extension options UI can show pending agent jobs. No schema change was required because `tool_jobs` already exists in the V2 migration.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass. Manual curl/database claim testing still needs a real `tool_jobs` row in Supabase.

## Phase A Review Gate

Implementation is complete and committed through the `/agent` chat surface. Verification on 2026-07-06:

- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm run build` passes after rerunning outside the sandbox because `.next/trace-build` hit a Windows `EPERM` in the sandbox.
- `npm run test:orchestrator` passes 7/7 after rerunning outside the sandbox because `.tmp/orchestrator-test` writes hit the same sandbox `EPERM`.
- `npm run build:extension` passes after rerunning outside the sandbox because the build needed to unlink existing ignored `extension/dist` files.

Manual acceptance still requires Aryan to run `supabase/2026_v2_agent.sql` in Supabase, then test `/agent` against the real mirror:

1. "Get me the next step for the Duraco deal" should use `db_search_records` / `db_get_record` and answer from the local mirror, labeled as of last sync.
2. "Merge these duplicate accounts" should not improvise; it should call `request_new_tool` and create a `tool_requests` row.

Stop here for review before Phase B. No Zoho calls or CRM writes exist in Phase A.

## Phase A Checkpoint: Agent Routes + Chat UI

Added the Phase A server loop in `lib/agent/loop.ts`: it persists the user message, calls the user's existing LLM credential through `runTools()`, executes only Tier-0 tools, persists assistant/tool messages, emits SSE events, and audits `agent_turn` / `tool_call`. The loop enforces the Phase A budgets: max 15 tool calls and 3 minutes wall clock.

Added `/api/agent/sessions`, `/api/agent/sessions/[id]`, and `/api/agent/sessions/[id]/messages`. Message POST streams typed SSE events: `assistant_delta`, `tool_call`, `tool_result`, `done`, and `error`. Routes use the existing server auth guard and user-scoped Supabase client so RLS applies.

Added `/agent` with a session list, chat pane, streaming assistant messages, and visible Tier-0 tool trace rows. Added the Agent nav item and protected `/agent` in middleware. Phase A UI explicitly labels responses as local DB-only; no Zoho tools are available yet.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.

## Phase A review (2026-07-06, chat review)

Verdict: high quality, spec-conformant, approved with two small fixes applied by the reviewer. Verified independently: committed tree typechecks clean, orchestrator tests 7/7, migration SQL matches the spec with proper role-checked RLS, `db_query` is structured-only, tool args double-validated (JSON Schema + Zod), unknown tools error back to the model, budgets enforced, mirror refactor leaves a single shared matching implementation used by both the run pipeline and the agent. Docs honest and complete — no slop found.

Fixes applied:
1. `app/api/agent/sessions/[id]/messages/route.ts` — session lookup now enforces ownership explicitly (`user_id === auth.user.id`) and rejects archived sessions. RLS let admins READ any session, so an admin posting into another user's chat would have started a turn that died mid-way on the message-insert policy.
2. `lib/agent/loop.ts` — transcript rebuild now skips assistant tool-call marker rows (tool_name set, no content); they exist for UI trace/audit but replayed as empty assistant messages in the prompt.

Noted as a KNOWN Phase A limitation (fix scheduled first in Phase B): the transcript is flattened to one text block per model call (`composeAgentInput`) instead of item-based `function_call`/`function_call_output` pairing. Fine for Phase A's single-tier loop; must be upgraded before multi-step Zoho tool chains.

Next: `workflows/SPEC_v2_phase_b_extension_bridge.md` — extension job bridge + live Zoho reads (GET-only), transcript upgrade first.
## Phase B Checkpoint: Item-Based Tool Transcript

Started Phase B with the transcript upgrade required before multi-step live Zoho tools. Both LLM providers now send item-based Responses input by default: text messages, assistant `function_call` items, and paired `function_call_output` items. `AGENT_FLAT_TRANSCRIPT=1` remains as a one-release fallback.

Call IDs are persisted inside `agent_messages.tool_args._call_id` instead of adding a column. This keeps already-run V2 migrations compatible while preserving the required call_id round-trip for new tool calls. Legacy tool rows without `_call_id` are replayed as plain text fallback context rather than dropped.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.
## Phase B live-read timeout debug (2026-07-07, chat)

Symptom: mirror search fine, Tier-1 job queued, backend expires with "Timed out waiting for the Chrome extension to report this job" — extension never reported.

Diagnosis (two stacked causes):
1. **Job silently never claimed when no crm.zoho.com tab matched.** `jobs.ts pollOnce()` returned BEFORE claiming when `tabs.query` found no CRM tab, while the 1-minute run-items poll kept `last_seen_at` fresh — so the backend preflight passed, the job sat `queued`, and the user got the generic 90s timeout. This exactly matches the reported symptom.
2. **The fe7cca2 page-context executor could never run on Zoho anyway.** It injected an inline `<script>` element; Zoho CRM's page CSP blocks inline scripts, so `pageRunner` would never execute and every claimed job would burn the 20s content timeout and report a useless "page-context executor" error.

Fixes:
- `extension/src/jobs.ts` — tab lookup moved AFTER claim; missing tab now reports `failed` immediately with "No crm.zoho.com tab is open…" (actionable chat feedback in seconds, not a 90s timeout). Step-level `saveLastJobStatus` breadcrumbs added: connected → claimed → running-in-tab → completed/failed.
- **Executor switched to `chrome.scripting.executeScript({ world: "MAIN" })`** driven from the background worker — CSP-immune, and the promise resolves with the runner's return value so the postMessage plumbing is gone. New self-contained `extension/src/page-runner.ts` (GET-only, same header/fallback/logged-out logic; MUST stay closure-free — it is serialized into the page). `content.ts` reduced to the ping listener. `manifest.json` adds the `scripting` permission (answers: yes executeScript, yes scripting permission).
- `lib/agent/bridge.ts` — timeout errors now distinguish "never picked up" (check toggle + CRM tab) from "picked up but never reported" (refresh the tab).

Verified: `npx tsc --noEmit` clean. `npm run build:extension` must run on the dev machine (esbuild binary is win32 in node_modules). After rebuilding, RELOAD the unpacked extension; content-script changes also need a crm.zoho.com tab refresh.

## Phase B review (2026-07-07, chat review)

Verdict: approved, one real defect fixed, no blocking issues. Independently verified: committed tree typechecks clean; extension executor is grep-provably GET-only (single fetch path, `method: "GET"`, only 4 read functions mapped); claim is atomic (status-guarded update + lost_race); sweeps correct and same-user scoped; report finalizes only the owner's `running` job; bridge fails before side effects on offline extension, expires timed-out jobs with a guarded update, and maps `zoho_logged_out` to user guidance; tier-1 args are Zod-validated + field-checked BEFORE queueing; `zoho_read_api` allowlist is anchored and GET-only; item-based transcript pairs `function_call`/`function_call_output` by `call_id`, `_call_id` persistence is backward-compatible, legacy tool rows fall back to text, `AGENT_FLAT_TRANSCRIPT=1` path intact; chat handles `tool_status` keyed by call_id.

Defect fixed (extension/src/background.ts): the job poller was a `setTimeout` chain started at worker startup — MV3 terminates idle service workers (~30s), killing the chain; job pickup could stall indefinitely until an unrelated wake. The existing 1-minute alarm now also fires `pollAgentJobOnce()`, bounding worst-case pickup latency to the alarm period (worker wake re-runs `startJobPolling` for the fast loop).

Non-blocking recommendations (Phase C backlog):
1. `lib/agent/bridge.ts` EXTENSION_LIVE_MS=60s can spuriously report "extension not connected" during a worker-teardown gap; consider 120s.
2. `extension/src/jobs.ts` calls handshake+claim every 1.5s cycle; claim alone updates last_seen — drop the per-cycle handshake to halve request volume.
3. `extension/src/zoho-api.ts` `rawGet` trusts server-validated paths; add the same allowlist check extension-side as defense-in-depth.
4. Missing tests: none for jobs claim/report atomicity or bridge timeout paths — add route-level tests when a test harness for Next routes lands (orchestrator-style pure-function extraction would work: move sweep/claim decisions into lib functions).

## Phase B Checkpoint: Server Bridge Wait Loop

Added `lib/agent/bridge.ts` for Tier-1 extension-backed tools. It fails before side effects if the user's extension has not handshaken within 60 seconds, enqueues one `tool_jobs` row, emits queued/running status updates, polls every 500ms, expires timed-out jobs, and converts `zoho_logged_out` failures into direct user guidance.

Wired the agent loop so Tier-1 tool calls use the bridge while Tier-0 tools still run in-process. The chat UI now understands `tool_status` SSE events and labels the agent surface as Phase B read-only bridge work.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass. Fake-job done/failed testing still needs a Supabase row or the extension executor from the next checkpoint.
## Phase B Checkpoint: Tier-1 Live Read Tool Definitions

Added Tier-1 tool definitions for `zoho_search`, `zoho_get_record`, `zoho_get_related`, and `zoho_read_api`. Args are Zod-validated server-side before queueing. `zoho_search` requires exactly one of `criteria`, `name`, or `tag`; `zoho_read_api` is GET-only via anchored allowlist regexes; params are capped at eight keys.

`zoho_get_record` validates requested field API names against `zoho_field_meta` before a job is inserted. The loop now exposes Tier-0 plus Tier-1 tools to the model, routes Tier-1 calls through the extension bridge, and keeps the agent instructions honest about mirror vs live sources and the Phase B no-write boundary.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.
## Phase B Checkpoint: Extension GET Job Executor

Finished the Phase B extension executor for read-only agent jobs. Added a GET-only Zoho session API helper, content-script execution for `zoho_search`, `zoho_get_record`, `zoho_get_related`, and `zoho_read_api`, and a separate background `jobs.ts` poller that claims one agent job at a time only when the extension is enabled and a `crm.zoho.com` tab exists. The old Phase 3 dry run-item polling path remains separate.

The options page now shows queued agent jobs from handshake plus a last-job status line, and the enable toggle is labeled as read-only Zoho session access. Logged-out Zoho detection reports `zoho_logged_out` back to the server.

Verified after this checkpoint: `npm run typecheck`, `npm run lint`, and `npm run build:extension` pass. GET-only proof: `jobs.ts`/`zoho-api.ts` contain one CRM fetch path and it uses `method: "GET"`; no PUT/POST/PATCH/DELETE CRM path exists in the Phase B executor.
## Phase B Verification Gate

Automated verification passed after the extension executor checkpoint: `npm run typecheck`, `npm run lint`, `npm run build`, `npm run build:extension`, and `npm run test:orchestrator` (7/7). The production build still emits Next's middleware-to-proxy deprecation warning, but it completes successfully.

Manual live acceptance remains: reload the unpacked extension, keep the toggle enabled with a logged-in `crm.zoho.com` tab, then ask `/agent` "Get me the next step for the Duraco deal." Expected trace: mirror search first, then live `zoho_get_record`, final answer labeled live. Negative paths to spot-check manually: extension disabled/offline, non-allowlisted `zoho_read_api`, Zoho logged out, and a timed-out job.
## Phase B Runtime Test Fix: Extension Backend Errors

During extension testing, Chrome surfaced stack traces at `extension/src/api.ts` instead of a useful root cause when the backend fetch failed or returned a non-OK response. `appFetch` now reports the concrete URL plus timeout/backend/host-permission guidance, the alarm-triggered dry poll catches failures instead of surfacing uncaught promise errors, and the manifest includes `http://127.0.0.1:3000/*` alongside `localhost`.

Verified after this fix: `npm run typecheck`, `npm run lint`, and `npm run build:extension` pass.

Follow-up from first live-read attempt: mirror search worked, but `zoho_get_record` failed preflight with "Chrome extension is not connected." The server liveness window is now 120s instead of 60s so MV3's 1-minute alarm wake plus normal jitter does not falsely mark a recently handshaking extension offline.

HeySnap session-API reference confirmed the Zoho fetch must run in the actual `crm.zoho.com` page context, not the extension service worker. The content script now injects a one-shot page-context runner for `zoho_search`, `zoho_get_record`, `zoho_get_related`, and `zoho_read_api`; the page runner reads `#token`, sends `X-ZCSRF-TOKEN: crmcsrfparam=<token>`, `X-CRM-ORG: 890324941`, `X-Requested-With`, `credentials: "include"`, and posts the JSON/error result back to the content script for reporting.

## Phase C Checkpoint: Live Zoho to Mirror Sync

Added `lib/records/zoho-upsert.ts` for live Zoho API rows. It intentionally stays separate from `scripts/import-masters.mjs` because CSV exports and live API payloads use different shapes; field-map unification remains a Phase E hardening item. The mapper preserves the full live record in `raw_data`, composes canonical Zoho URLs, resolves contact/deal account/contact FKs from existing mirror rows, warns on unresolved lookups, and classifies each row as inserted, updated, or unchanged before upserting only changed rows.

Added `db_sync_records` as a Tier-1 in-process tool. The model must pass `{ module, records }` with 1-200 live Zoho records that each have a string `id`; Zod validation happens before the service client upsert. The tool audits `mirror_sync` with counts and returns capped inserted/updated names plus warnings. Existing Zoho read tools still go through the extension bridge; this local DB sync never writes to Zoho.

Agent instructions now tell the model to use `zoho_search` for tag-driven pulls, paginate until `more_records=false`, then call `db_sync_records` only for the records the user asked to sync. The Agent UI label now reflects Phase C.

Verified after this checkpoint: `npm run typecheck`, `npm run lint`, and `npm run test:records` pass. Live acceptance still needs Aryan to create/tag 2-3 demo records in Zoho, ask the agent to pull that tag into the mirror, verify Records shows the rows, then re-run and confirm all records report unchanged.
