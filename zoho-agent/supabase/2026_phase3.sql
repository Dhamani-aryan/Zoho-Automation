-- Phase 3: Chrome extension token auth and live execution columns.
-- Run after supabase/schema.sql and supabase/2026_phase2.sql.

alter type public.run_status add value if not exists 'cancelled';

create table if not exists public.user_extension_tokens (
  user_id uuid primary key references public.users(id) on delete cascade,
  token_hash text not null,
  label text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create index if not exists user_extension_tokens_hash_idx
on public.user_extension_tokens (token_hash)
where status = 'active';

alter table public.user_extension_tokens enable row level security;

drop policy if exists "own ext token read" on public.user_extension_tokens;
create policy "own ext token read"
on public.user_extension_tokens for select
to authenticated
using (user_id = auth.uid());

-- Token writes go through server routes using the service-role client after
-- the signed-in user has been verified.

alter table public.workflow_runs
  add column if not exists approved_by uuid references public.users(id),
  add column if not exists approved_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists stop_reason text;

alter table public.workflow_run_items
  add column if not exists attempts int not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists executed_at timestamptz,
  add column if not exists verified boolean,
  add column if not exists evidence jsonb;
