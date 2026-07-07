# V2 Decisions

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
