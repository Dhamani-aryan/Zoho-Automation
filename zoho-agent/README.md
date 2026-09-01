# Zoho Agent App

This folder contains the Next.js application, API routes, Supabase schema, validation engine, agent runtime, and Chrome extension bridge for Zoho Workflow Agent.

## Included

- Next.js App Router application.
- Supabase Auth, RLS policies, and role guards.
- Operational dashboard for runs and agent activity.
- CSV and Markdown import preview routes.
- Zoho field metadata import route.
- Per-user LLM credential settings with encryption.
- Natural-language command parsing.
- Deterministic validation and preview run creation.
- Agent chat runtime for guided CRM work.
- Chrome extension bridge for live Zoho session reads, writes, and UI workflows.

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Fill the Supabase values:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Add `LLM_CRED_ENC_KEY` before testing encrypted credential storage.
4. Leave `OPENAI_API_KEY` empty unless you need a server-side fallback provider.
5. Install dependencies with `npm install`.
6. Start locally with `npm run dev`.

## Database setup

Run `supabase/schema.sql` in the Supabase SQL editor. It creates the application tables, RLS policies, workflow seed records, and preview/run tables.

## Auth setup

The app uses Supabase Auth with SSR cookies. Page reads use the signed-in user's session so RLS applies. Service-role access is reserved for privileged import and admin routes after the caller's role has been verified.

Create the first admin user:

```sql
insert into public.users (id, name, email, role, status)
values (
  '<auth-user-uuid>',
  'Demo Admin',
  'admin@example.com',
  'admin',
  'active'
);
```

## Preview scope

The preview pipeline can parse a command, resolve records, validate fields, and persist a run preview without touching Zoho. Live execution is handled separately through the extension bridge after the user is authenticated and the run is approved.

## Agent scope

The agent runtime is built for controlled CRM operations:

- Use mirror data for fast discovery.
- Use live Zoho reads when current truth matters.
- Prefer API writes when possible.
- Use browser/UI automation for composer and scheduler flows.
- Verify every state-changing action through read-back.
- Report skips, failures, and mismatches honestly.

## Scripts

```sh
npm run dev
npm run build
npm run typecheck
```

Additional focused test configs live in the root of this folder.
