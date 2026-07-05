# Phase 2 Decisions

Confirmed on 2026-07-04.

1. Phase 2 stops at parsed, validated, saved previews. It never calls Zoho and never writes CRM data.
2. LLM access is per user. Users connect either a ChatGPT/Codex credential flow or their own OpenAI API key in Settings.
3. LLM secrets are stored in `public.user_llm_credentials` and encrypted with `LLM_CRED_ENC_KEY`.
4. `/api/plan/parse` returns strict plan JSON from the selected provider, then applies server-side guardrails.
5. `/api/plan/validate` resolves records from Supabase under RLS and builds deterministic preview items.
6. Unsupported selectors or unmapped blocks become warnings or `needs_review`; the app does not guess.
7. Saved preview runs use existing `workflow_runs` and `workflow_run_items` tables.
8. A preview with unresolved issues is saved as `draft`; a clean preview is saved as `preview_ready`.
9. Read-only runs keep `approval_required=false`; write runs keep `approval_required=true`.
10. The first deterministic preview mapper is `update_deal_field`, including Deal `Next_Step`.

## Post-review fixes (2026-07-04)

Applied after review of the initial Phase 2 build:

1. **OAuth account-id decode** — corrected to read the nested claim `payload["https://api.openai.com/auth"].chatgpt_account_id` (was a wrong flat dotted key that always returned null). `lib/llm/codex-oauth.ts`.
2. **Device redirect URI** — corrected to `https://auth.openai.com/deviceauth/callback` (was `/api/accounts/deviceauth/callback`, which would fail the device token exchange).
3. **Providers now send attached files** — added `composeUserInput()` in `lib/llm/parse-json.ts`; both `openai-codex.ts` and `openai-key.ts` fold the parsed file summaries into the model input (previously only the command was sent, so file-driven commands were blind).
4. **Real tag selection** — `record_selector.mode=tag` now filters against each record's `raw_data.tags`/`matched_tags` (was stubbed off with a false "tags not imported" message). Tags ARE present in `raw_data`.
5. **Per-block preview mappers** — implemented for change_owner, add_tags/remove_tags, create_task, complete_task, schedule_email, and update_account/contact/deal fields (previously only update_deal_field; all others fell to needs_review). Includes picklist-membership checks, email-format checks, opt-out and no-email skips, and future-date checks.
6. **Name/file resolution fallback** — exact → starts_with → contains; unmatched values are reported as `needs_review` items and multi-match values are flagged ambiguous, so no selector value silently vanishes.
7. Preview result now carries eligible/skipped/needs_review counts. `change_owner` validates against `KNOWN_OWNERS` in `lib/constants.ts`.

VERIFY on the dev machine (could not run in the review sandbox due to a file-sync lag): `npm run typecheck && npm run lint && npm run build`.

## Device-code "Check approval" infinite-spinner fix (2026-07-05)

Symptom: after approving on the OpenAI page, "Check approval" spun forever. Two layers:

1. **Trigger:** `LLM_CRED_ENC_KEY` was missing from `.env.local` (spec step 1 was skipped), so `encryptSecret()` threw after a successful token exchange → the poll route 500'd with a non-JSON body. Fixed: key generated and added; route now catches encryption errors and returns a clear JSON message.
2. **Spinner:** `pollDeviceFlow` in `settings-openai-card.tsx` had no try/catch/finally — a non-JSON response made `response.json()` throw before `setLoading(false)`. The same latent bug existed in `startDeviceFlow`, `saveApiKey`, and `disconnect` (only the paste handler had been fixed, commit 8027eef). Fixed: all mutating calls now go through a `postJson` helper with a 25s timeout, JSON-safe parsing, and `finally { setLoading(false) }`.

Hardened the poll route to match the pi reference: 15s timeouts on both OpenAI fetches; 403/404/`deviceauth_authorization_pending`/`slow_down` → friendly "still pending" (428); 200-without-code treated as pending instead of exchanging `undefined`; OpenAI error objects normalized to strings so the UI never renders an object.

**Same root cause broke the paste-credential and API-key flows** (all three routes call `encryptSecret`). Worse, the paste route performed its validation refresh — which ROTATES the refresh token at OpenAI — before crashing, so each failed paste attempt invalidated the token in the user's local `auth.json`. Fix: new `credentialEncryptionReady()` in `lib/crypto/cred.ts`; all three credential routes now verify encryption config (and, for paste, the Supabase service client) BEFORE any side-effecting upstream call. After a failed paste, users must run `codex login` again to mint a fresh token before re-pasting.

**Files changed (2026-07-05, all changes together):**

- `.env.local` — added the missing `LLM_CRED_ENC_KEY` (generated 32-byte base64; not committed).
- `lib/crypto/cred.ts` — added `credentialEncryptionReady()`: config check without encrypting; used by routes to fail fast before side-effecting calls.
- `app/api/settings/llm/codex/poll/route.ts` — rewritten: early config check; 15s `AbortController` timeouts on both OpenAI fetches; pending detection (403/404/`deviceauth_authorization_pending`/`slow_down` → 428 with friendly message); 200-without-code = pending; `encryptSecret` wrapped; error objects normalized to strings via `extractErrorCode()`.
- `app/api/settings/llm/codex/paste/route.ts` — config + service-client checks moved BEFORE the token-rotating validation refresh; `encryptSecret`/service checks deduplicated after the move.
- `app/api/settings/llm/api-key/route.ts` — early config check before the OpenAI validation call.
- `components/settings-openai-card.tsx` — all mutating handlers (`saveApiKey`, `startDeviceFlow`, `pollDeviceFlow`, `savePastedCredential`, `disconnect`) refactored onto a shared `postJson()` helper: 25s timeout, JSON-safe parsing (`.json().catch(() => ({}))`), `errorText()`/`failureText()` string-safe messages, `finally { setLoading(false) }`. `refreshStatus()` wrapped in try/catch.
- Invariant for future work: **no credential route may call OpenAI (or any side-effecting upstream) before `credentialEncryptionReady()` and the Supabase service client are confirmed**, and no client handler may await a fetch outside try/finally that resets its loading state.

Verified: `npx tsc --noEmit` passes. `npm run build` still needs a run on the dev machine (sandbox can't run SWC).

## Follow-up: `token_exchange_user_error` diagnostics + per-action busy state (2026-07-05)

After the fixes above, connect attempts surfaced OpenAI's error code `token_exchange_user_error` (device flow; paste also failing). This code comes from OpenAI's token endpoint, is not publicly documented, and the "user_error" naming suggests an account-side condition (e.g. approving with a ChatGPT account that lacks Codex access, or a rotated/burned refresh token from the earlier crashed paste attempts). Changes to diagnose from the real response instead of guessing:

- `app/api/settings/llm/codex/poll/route.ts` — added `bodySnippet()`; device-poll and token-exchange failures now `console.error` the OpenAI status plus a token-scrubbed, 300-character body snippet and return the same diagnostic in the JSON error.
- `app/api/settings/llm/codex/paste/route.ts` — refresh-validation failures now log and surface status + scrubbed body (access/refresh tokens deleted before stringify) and explicitly suggest a fresh `codex login`.
- `components/settings-openai-card.tsx` — replaced the single shared `loading` boolean with per-action `busy` state ("apikey" | "start" | "poll" | "paste" | "disconnect"). Previously clicking "Check approval" made ALL card buttons spin (users read it as the paste flow starting). Buttons disable while any action runs but only the active one shows a spinner.

Verified: `npx tsc --noEmit` passes. Next debugging step is reading the full OpenAI error body from the UI message or the `npm run dev` terminal (`[codex-poll]` / `[codex-paste]` lines).

**Resolution trail (2026-07-05):** with diagnostics in place the device flow got past OpenAI entirely (`token_exchange_user_error` no longer reproduced — consistent with burned tokens/expired device session from the earlier crashed attempts) and failed at credential storage: `Could not find the table 'public.user_llm_credentials' in the schema cache`. Root cause: **Phase 2 build-order step 1 was never executed on the dev machine** — neither `LLM_CRED_ENC_KEY` in `.env.local` (fixed earlier today) nor the `supabase/2026_phase2.sql` migration (run by Aryan in the Supabase SQL editor). No code change required for this last error; the migration is idempotent.

## Parse "Request failed." fix — Codex provider was never functional (2026-07-05)

First real parse attempt on `/run/new` returned the generic "Request failed.". Two layers again:

1. **Route:** `/api/plan/parse` had no try/catch around `loadPromptCatalog` / `getLLMProviderForUser` / `provider.parsePlan`, so any provider throw became a non-JSON 500 and the client's `readJson` fell back to "Request failed.". Same latent pattern in `/api/plan/validate` and `/api/runs` (POST). All three now wrap the risky section and return the real error message as JSON (plus `console.error` with `[plan-parse]` / `[plan-validate]` / `[runs-create]` prefixes).
2. **Provider (`lib/llm/openai-codex.ts`) — the actual failure.** Checked against the pi reference (now at `packages/ai/src/api/openai-codex-responses.ts`; the provider file was renamed since the spec was written). Three breakages:
   - **Stale model id.** Default was `gpt-5-codex`, which no longer exists in the registry (`openai-codex.models.ts` now lists `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`). New default: `gpt-5.4` (override via `LLM_MODEL`).
   - **Streaming.** The Codex backend is SSE-only: the reference always sends `stream: true` with `accept: text/event-stream`. We sent a non-streaming request and called `response.json()`. Now: send `stream: true`, buffer the SSE body, take the final object from the `response.completed` event (fallback: accumulated `response.output_text.delta`), handle `response.failed`.
   - **Headers.** Missing `originator`, `User-Agent`, `session-id`/`x-client-request-id` (the credential spec warned header diffs cause 403s). Now mirrored from the reference (`originator: pi`).
   - Also added a 90s timeout and verbatim status+body error surfacing (includes the model id so registry drift is obvious next time).

`npx tsc --noEmit` passes. NOTE for future maintenance: the Codex model registry drifts — if parse starts failing with a model error, re-check `openai-codex.models.ts` in the pi repo and update `LLM_MODEL`/default.

Follow-up fix: the backend then returned 400 "Input must be a list" — the Codex backend requires `input` as a list of message items (`[{type:"message", role:"user", content:[{type:"input_text", text}]}]`), unlike api.openai.com which also accepts a plain string. Fixed in `openai-codex.ts`.

Follow-up fix 2: "Codex returned an empty response" — SSE extraction widened in `openai-codex.ts` (`response.completed` object, `output_text.delta` accumulation, `output_item.done`/`content_part.done` items, refusals); on empty output the error now lists the SSE event types seen and dumps the raw stream to the terminal as `[codex-parse]`.

## First successful parse — prompt/validator gaps found on plan quality (2026-07-05)

Parse now works end to end. The first real plan exposed two spec-vs-implementation gaps:

1. **Prompt was missing the tag catalog** (spec §3 required "available tags so tag selectors validate"). The model classified "the KD Blitz deals" as `mode:"names"` with value "KD Blitz" and even warned it might be a tag. `loadPromptCatalog()` now also selects `raw_data->>tags/matched_tags/all_tags` from accounts/contacts/deals (limit 2000 each), dedupes into per-module tag lists, and the prompt instructs: command matches a known tag → `mode:"tag"`; `mode:"names"` only for actual record names.
2. **Config-key drift.** The model emitted `new_value`; the preview mapper only read `cfg.value`, which would have flagged every row "No new value provided". The mapper now accepts `value ?? new_value`, and the prompt documents the EXACT config keys per block (field updates `{field_api_name, value}`, change_owner `{target_owner}`, tags `{tag_names[]}`, create_task `{subject, due_date}`, complete_task `{subject}`, schedule_email `{subject, schedule_date, schedule_time, to_email?}`).

`npx tsc --noEmit` passes.

Follow-up: a later parse hit the Zod gate ("The model returned malformed plan JSON" with no visible detail). Two changes: (1) the 422 error string now embeds the first 5 Zod issues (path: message) and the raw plan is logged as `[plan-parse]`; (2) `lib/plan/schema.ts` now tolerates harmless drift — enums lowercased via `.transform().pipe()` (Zod v4: generic-tuple `z.enum` widens to string, so literal arrays are inlined), string coercion on values/warnings/missing_info/tag, defaults for omitted blocks/record_selector. Guardrails still re-verify slugs and field names, so leniency does not weaken safety.

Follow-up 2: with detail visible, the failure was `"filter": {}` — the model copies the shape example's `filter` key even in tag mode, and empty-object members failed as "expected string, received undefined". Schema now normalizes empty/partial/nulled `filter` to undefined (preprocess in `recordSelectorSchema`), same null→undefined guard on `tag`/`values`, and the prompt adds: omit optional keys entirely when unused, never emit empty objects or null.

## Read queries + smarter deal resolution (2026-07-05)

Test command "Check the duraco tapes deal and tell me the next step" exposed two gaps (the parser behaved correctly — it refused to invent a block and said so in missing_info):

1. **Deals weren't findable by company name.** Deals are named "{Account} | SAP Cloud ERP" but users type company names. `resolveRecords` (names/file modes) now matches against the deal name AND its account name (from `raw_data` Account_Name variants), with a new word-level token fallback (each query token ≥3 chars prefix-matches a name word in either direction, so "duraco tapes" ↔ "Duraco Tape & Label | SAP Cloud ERP"). Unmatched values now include up to 3 near-miss suggestions in the needs_review message; ambiguous values list their matches.
2. **No read block existed** — "what is <field> on <record>" had no catalog entry (this would also have failed acceptance test 6, "list IT contacts"-style reads). Added `read_fields`: seed SQL in `supabase/2026_read_fields_seed.sql` (RUN THIS in the Supabase SQL editor), mapper in `lib/plan/validation.ts` (reads values from the synced local copy, labeled "as of last import"), prompt config-key line in `system-prompt.ts`. Read runs skip the approval gate per Phase 1 decision 11. Live Zoho reads arrive with the Phase 3 extension.

Design note (recorded after discussion with Aryan): the agent stays parse-then-validate rather than tool-calling. Rationale: the preview/approve gate requires the full action set to be fixed before approval; deterministic execution is what makes approval meaningful; batch execution with a model in the loop is slower, costlier, and nondeterministic. Tool-calling remains a v1.1 candidate strictly BEFORE the approval line (e.g. DB-informed disambiguation during parse). Resolution misses like this one are fixed by better deterministic matching, not by an agent loop.

**MILESTONE (2026-07-05): first correct end-to-end parse + validate on real data.** "Set Next Step to \"2nd Email\" for the KD Blitz deals" → clean plan (`mode:"tag"`, `tag:"KD Blitz"`, `update_deal_field {field_api_name:"Next_Step", value:"2nd Email"}`) → Validate resolved the correct tagged deals. Acceptance test 1 of ~10 passed; remaining tests per the Phase 2 done-when list (§10 of the Phase 2 spec).

## Third credential option: paste Codex credential (2026-07-04)

Added because device-code login depends on the "device authorization" toggle in a user's ChatGPT security settings, which isn't available/enabled on every account. This option matches the pre-existing local workflow.

- Route: `POST /api/settings/llm/codex/paste` — accepts `{ credential }` = the pasted `~/.codex/auth.json` contents (or a bare refresh_token). Extracts the refresh token, validates it by performing a real refresh against `https://auth.openai.com/oauth/token`, stores the freshly minted refresh token encrypted (kind `codex_oauth`), and records the account id.
- UI: Settings → OpenAI connection → ChatGPT subscription card now has "Or paste your Codex credential" (textarea + Connect from paste) beneath the device-code flow.
- Behavior: one-time paste; the hosted app owns and auto-refreshes its own copy thereafter (no local instance, no npm run dev). Caveat: refresh-token rotation means the hosted app and a local `codex` CLI can occasionally invalidate each other — re-paste if prompted to reconnect.
- All three connect methods (device-code, paste, API key) converge on the same encrypted `user_llm_credentials` row and the same per-user provider resolution.
