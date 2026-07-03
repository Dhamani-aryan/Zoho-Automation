# Zoho Agent

Local-first scaffold for the KloudData Zoho workflow executor.

## What is included

- Next.js App Router project under `zoho-agent`
- Operational dashboard UI for Phase 1
- Supabase schema, RLS policies, and action-block seed data
- CSV/Markdown import preview route
- Manual Zoho field metadata JSON ingest route
- Per-user OpenAI credential settings, encrypted in Supabase
- Phase 2 command parse, validation, and preview run flow

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Fill the Supabase values when the project is created:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Leave `OPENAI_API_KEY` empty unless a temporary server-side fallback is needed.
4. Add `LLM_CRED_ENC_KEY` before enabling Phase 2 credential storage. Generate a 32-byte key and base64-encode it.
5. Install dependencies with `npm install`.
6. Start locally with `npm run dev`.

## Database setup

Run `supabase/schema.sql` in the Supabase SQL editor. It creates the Phase 1 tables, RLS policies, and workflow seed records.

For Phase 2, also run `supabase/2026_phase2.sql`. It creates encrypted per-user LLM credential storage.

## Auth setup

This app uses Supabase Auth plus `@supabase/ssr` cookies. Page reads use the signed-in user's session so RLS applies. Service-role access is reserved for CSV upserts into record tables and admin field-metadata upserts after the API route verifies the caller's role.

Create the first admin user:

1. In Supabase Dashboard, create an Auth user for Aryan.
2. Copy the Auth user UUID.
3. Insert the profile row in SQL:

```sql
insert into public.users (id, name, email, role, status)
values (
  '<auth-user-uuid>',
  'Aryan Dhamani',
  'aryan@klouddata.com',
  'admin',
  'active'
);
```

After that admin exists, normal app reads and protected routes resolve permissions from `public.users`.

## Phase 2 preview scope

Phase 2 adds preview-only workflow planning:

- `/settings` stores each user's own OpenAI credential.
- `/run/new` parses commands, validates matching imported records, and saves preview runs.
- `/run/[id]` shows the persisted per-record preview table.
- `/api/plan/parse`, `/api/plan/validate`, `/api/runs`, and `/api/runs/[id]` are auth-protected.

The Chrome extension and live Zoho execution start in Phase 3. Phase 2 does not call Zoho and does not write CRM data.

## Post-review fixes (2026-07-04)

The initial Phase 2 build was reviewed and corrected. Full list in `docs/PHASE_2_DECISIONS.md`. Summary of what changed and current behavior:

- **Codex OAuth**: account-id now read from the nested claim `access_token → ["https://api.openai.com/auth"].chatgpt_account_id`; device redirect URI is `https://auth.openai.com/deviceauth/callback`.
- **Providers send files**: `lib/llm/parse-json.ts` exports `composeUserInput()`, used by both `openai-codex.ts` and `openai-key.ts`, so attached CSV/MD summaries reach the model (not just the command).
- **Tag selection is real**: `record_selector.mode=tag` filters on each record's `raw_data.tags` / `matched_tags` (tags live in `raw_data`, there is no dedicated column).
- **Per-block preview mappers** in `lib/plan/validation.ts` for: update_deal_field, update_account_fields, update_contact_fields, change_owner, add_tags, remove_tags, create_task, complete_task, schedule_email — with picklist-membership, email-format, opt-out/no-email skips, and future-date checks. Owner targets validate against `KNOWN_OWNERS` in `lib/constants.ts`.
- **Record resolution** (names/file mode): exact → starts_with → contains; unmatched values become `needs_review` items and multi-matches are flagged ambiguous — nothing is dropped silently.
- Preview result carries `eligible_count` / `skipped_count` / `needs_review_count`.

### Intentional simplifications (not bugs — for Phase 3 to extend)

- `update_account_fields` / `update_contact_fields` currently preview a single `field_api_name` + `value`; multi-field `field_values` batches are not yet expanded.
- Duplicate-scheduled-email and duplicate-task checks are **deferred to Phase 3** (they need live Zoho); Phase 2 only flags what our own DB can see.
- Env knobs: `LLM_MODEL` (default `gpt-5-codex` for Codex, `gpt-4.1-mini` for API key), `CODEX_RESPONSES_URL`. The Codex chat request headers should be reconciled against the pi reference (`openai-codex-responses.ts`) during first live test — minor header diffs can cause 403s.
