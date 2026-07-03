# Spec: LLM Provider — Per-User Credentials (Codex subscription + API key)

Version 0.2 (2026-07-04). For the Phase 2 command parser. Implements the existing `LLMProvider` interface (`lib/llm/provider.ts`).

## Decision (confirmed with Aryan)

**Per-user credentials, not a global one.** Each user connects their OWN OpenAI access from their profile; the agent uses that user's account for their runs. **The app is a single shared hosted app (Vercel).** Two connection types, user's choice:

1. **ChatGPT subscription (Codex)** — user connects their ChatGPT Plus/Pro account. Endorsed by OpenAI ("Codex for OSS"). No API billing; draws on their subscription.
2. **API key** — user pastes an `sk-...` key from their own platform.openai.com account. Usage billed to them.

There is no global `LLM_PROVIDER` / global key. The provider is resolved **per request from the triggering user's stored credential**. If a user has none, parsing is disabled for them with a clear "Connect your OpenAI account in Settings" message.

Reference implementation to mirror (do not reinvent the protocol): `earendil-works/pi`, files `packages/ai/src/utils/oauth/openai-codex.ts` (OAuth incl. **device-code flow**) and `packages/ai/src/providers/openai-codex-responses.ts` (request/response). MIT licensed.

## CRITICAL constraint: hosted app must use the DEVICE-CODE flow for subscription login

OpenAI's Codex OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`) only accepts its **registered redirect URIs** (localhost:1455 and the device-auth callback). A hosted Vercel app **cannot** use its own domain as an OAuth callback. Therefore the subscription connect flow uses the **device-code flow** (`loginOpenAICodexDeviceCode` in the reference):

1. User clicks "Connect ChatGPT" in Settings.
2. Backend calls `POST https://auth.openai.com/api/accounts/deviceauth/usercode` with `{ client_id }` → gets `device_auth_id`, `user_code`, `interval`.
3. App shows the user their `user_code` and the URL `https://auth.openai.com/codex/device` to open and approve.
4. Backend polls `POST https://auth.openai.com/api/accounts/deviceauth/token` with `{ device_auth_id, user_code }` until it returns `authorization_code` + `code_verifier` (handle `pending`/`slow_down`).
5. Exchange at `POST https://auth.openai.com/oauth/token` (grant_type `authorization_code`, redirect_uri = device callback) → `{ access_token, refresh_token, expires_in }`.
6. Extract `account_id` from the access-token JWT claim `https://api.openai.com/auth.chatgpt_account_id`.
7. **Store the refresh token + account_id ENCRYPTED, per-user** (see storage below). Never store on disk / never in `.env`.

API-key connect is trivial: user pastes `sk-...`, we validate with a cheap test call, store encrypted per-user.

## Per-user credential storage (new table)

```sql
create table public.user_llm_credentials (
  user_id uuid primary key references public.users(id) on delete cascade,
  kind text not null check (kind in ('codex_oauth','openai_api_key')),
  ciphertext bytea not null,          -- AES-256-GCM encrypted secret blob
  iv bytea not null,
  auth_tag bytea not null,
  account_id text,                    -- codex only (non-secret)
  access_token_expires_at timestamptz,-- codex only, for refresh timing
  label text,                         -- e.g. masked key tail 'sk-...abcd'
  status text not null default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.user_llm_credentials enable row level security;
-- user reads only own row; no client write (writes go through server routes on service key)
create policy "own cred read" on public.user_llm_credentials
  for select to authenticated using (user_id = auth.uid());
```

Encryption: AES-256-GCM with a server-only key `LLM_CRED_ENC_KEY` (32-byte, in Vercel env). Encrypt the secret (refresh token OR api key) before insert; decrypt only server-side at parse time. This means even a DB dump / service-role access does not expose raw credentials without the env key. RLS additionally stops users reading each other's rows.

## Refresh logic (codex, per-user)

At parse time for a codex user: if `access_token_expires_at` is within ~60s (or a call 401s), POST `https://auth.openai.com/oauth/token` (grant_type `refresh_token`, the decrypted refresh token, `client_id`), then re-encrypt & store the new refresh token + new expiry. Per-user in-process mutex to avoid double refresh.

## OAuth constants (confirmed from pi source)

- `CLIENT_ID = app_EMoamEEZ73f0CkXaXp7hrann`
- Token endpoint: `POST https://auth.openai.com/oauth/token`
- Refresh body (form-urlencoded): `{ grant_type: "refresh_token", refresh_token, client_id: CLIENT_ID }`
- Response: `{ access_token, refresh_token, expires_in }`. Expiry = `Date.now() + expires_in*1000`.
- Device endpoints & scope as listed in the flow above; `SCOPE = "openid profile email offline_access"`.

## OAuth constants (confirmed from pi source)

- `CLIENT_ID = app_EMoamEEZ73f0CkXaXp7hrann`
- Token endpoint: `POST https://auth.openai.com/oauth/token`
- Refresh body (form-urlencoded): `{ grant_type: "refresh_token", refresh_token, client_id: CLIENT_ID }`
- Response: `{ access_token, refresh_token, expires_in }`. New expiry = `Date.now() + expires_in*1000`.
- `account_id` is also decodable from the access-token JWT claim `https://api.openai.com/auth.chatgpt_account_id`, but the auth.json already stores it — prefer that.

## Refresh logic

On each parse call: if the cached access token expires within ~60s (or on a 401), POST the refresh, then **write the new tokens back to the auth file** (so Codex CLI and our app stay in sync) and use the new access token. Guard with a simple in-process mutex so concurrent parses don't double-refresh.

## Chat request

- **Codex credential** → mirror `openai-codex-responses.ts`: **OpenAI Responses API shape** against the ChatGPT backend Codex endpoint, `Authorization: Bearer <access_token>` + `chatgpt-account-id: <account_id>`, `store: false`, `instructions` + `input`. Copy the exact endpoint URL and full header set (originator/session/beta) from the reference — small header diffs cause 403s.
- **API-key credential** → standard `POST https://api.openai.com/v1/responses` (or chat/completions) with `Authorization: Bearer sk-...`.
- Model id is a config constant `LLM_MODEL`; confirm a Codex-available id from the reference's model registry at build time.

Both paths return the same `ParsedPlan`. The provider is chosen per-user by their stored `kind`.

## Interface contract (unchanged)

`parsePlan(input: { command, files[], actionBlockCatalog }) => ParsedPlan` returning `{ blocks[], records[], run_parameters, warnings[], missing_info[] }`. Resolve the credential from the **triggering user's** `user_llm_credentials` row. Validation and execution remain deterministic and provider-agnostic.

## Settings UI (new)

Profile/Settings page: "OpenAI connection" card showing current status (Not connected / ChatGPT connected / API key •••abcd). Two connect actions — "Connect ChatGPT" (device-code flow with the code + link + polling spinner) and "Add API key" (paste + validate). A "Disconnect" clears the row.

## Fallback / errors

- User has no credential → `ParsedPlan` with empty blocks and `missing_info: ["Connect your OpenAI account in Settings to run commands."]`. Never crash.
- Refresh fails / key invalid → mark row `status='needs_reauth'`, same friendly message.
- Log per parse to `audit_events` (`event_type: 'llm_parse'`): user, provider kind, latency, token usage if returned — **never** the secret.

## Security notes

- Per-user secrets encrypted at rest (AES-256-GCM, `LLM_CRED_ENC_KEY` env). RLS restricts row reads to the owner; client never writes the table (all writes via server routes on the service key).
- The token pasted in chat earlier belongs to a shared account (Harshit) — it is NOT used by this design; disregard/rotate it. Each user connects their own account through the app.
