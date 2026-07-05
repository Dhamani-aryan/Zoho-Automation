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

## Phase A Checkpoint: Agent Routes + Chat UI

Added the Phase A server loop in `lib/agent/loop.ts`: it persists the user message, calls the user's existing LLM credential through `runTools()`, executes only Tier-0 tools, persists assistant/tool messages, emits SSE events, and audits `agent_turn` / `tool_call`. The loop enforces the Phase A budgets: max 15 tool calls and 3 minutes wall clock.

Added `/api/agent/sessions`, `/api/agent/sessions/[id]`, and `/api/agent/sessions/[id]/messages`. Message POST streams typed SSE events: `assistant_delta`, `tool_call`, `tool_result`, `done`, and `error`. Routes use the existing server auth guard and user-scoped Supabase client so RLS applies.

Added `/agent` with a session list, chat pane, streaming assistant messages, and visible Tier-0 tool trace rows. Added the Agent nav item and protected `/agent` in middleware. Phase A UI explicitly labels responses as local DB-only; no Zoho tools are available yet.

Verified after this checkpoint: `npm run typecheck` and `npm run lint` pass.
