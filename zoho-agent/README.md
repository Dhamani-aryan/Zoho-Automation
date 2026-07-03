# Zoho Agent

Local-first Phase 1 scaffold for the KloudData Zoho workflow executor.

## What is included

- Next.js App Router project under `zoho-agent`
- Operational dashboard UI for Phase 1
- Supabase schema, RLS policies, and action-block seed data
- CSV/Markdown import preview route
- Manual Zoho field metadata JSON ingest route
- Environment placeholders for Supabase and OpenAI

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Fill the Supabase values when the project is created:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Leave `OPENAI_API_KEY` empty until Phase 2.
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

## Phase 1 scope

This app is for the foundation only:

- Login shell
- Dashboard
- Records browser
- File/import preview
- Manual field metadata import
- Run history shell

The Chrome extension and live Zoho execution start in Phase 3.
