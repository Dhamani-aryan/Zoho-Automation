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

## Third credential option: paste Codex credential (2026-07-04)

Added because device-code login depends on the "device authorization" toggle in a user's ChatGPT security settings, which isn't available/enabled on every account. This option matches the pre-existing local workflow.

- Route: `POST /api/settings/llm/codex/paste` — accepts `{ credential }` = the pasted `~/.codex/auth.json` contents (or a bare refresh_token). Extracts the refresh token, validates it by performing a real refresh against `https://auth.openai.com/oauth/token`, stores the freshly minted refresh token encrypted (kind `codex_oauth`), and records the account id.
- UI: Settings → OpenAI connection → ChatGPT subscription card now has "Or paste your Codex credential" (textarea + Connect from paste) beneath the device-code flow.
- Behavior: one-time paste; the hosted app owns and auto-refreshes its own copy thereafter (no local instance, no npm run dev). Caveat: refresh-token rotation means the hosted app and a local `codex` CLI can occasionally invalidate each other — re-paste if prompted to reconnect.
- All three connect methods (device-code, paste, API key) converge on the same encrypted `user_llm_credentials` row and the same per-user provider resolution.
