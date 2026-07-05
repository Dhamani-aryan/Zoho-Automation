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

## Third credential option: paste Codex credential (2026-07-04)

Added because device-code login depends on the "device authorization" toggle in a user's ChatGPT security settings, which isn't available/enabled on every account. This option matches the pre-existing local workflow.

- Route: `POST /api/settings/llm/codex/paste` — accepts `{ credential }` = the pasted `~/.codex/auth.json` contents (or a bare refresh_token). Extracts the refresh token, validates it by performing a real refresh against `https://auth.openai.com/oauth/token`, stores the freshly minted refresh token encrypted (kind `codex_oauth`), and records the account id.
- UI: Settings → OpenAI connection → ChatGPT subscription card now has "Or paste your Codex credential" (textarea + Connect from paste) beneath the device-code flow.
- Behavior: one-time paste; the hosted app owns and auto-refreshes its own copy thereafter (no local instance, no npm run dev). Caveat: refresh-token rotation means the hosted app and a local `codex` CLI can occasionally invalidate each other — re-paste if prompted to reconnect.
- All three connect methods (device-code, paste, API key) converge on the same encrypted `user_llm_credentials` row and the same per-user provider resolution.
