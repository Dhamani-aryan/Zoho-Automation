-- Phase 2: per-user LLM credentials for command parsing.
-- Run after supabase/schema.sql.

create table if not exists public.user_llm_credentials (
  user_id uuid primary key references public.users(id) on delete cascade,
  kind text not null check (kind in ('codex_oauth', 'openai_api_key')),
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  account_id text,
  access_token_expires_at timestamptz,
  label text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists user_llm_credentials_set_updated_at on public.user_llm_credentials;
create trigger user_llm_credentials_set_updated_at before update on public.user_llm_credentials
for each row execute function public.set_updated_at();

alter table public.user_llm_credentials enable row level security;

drop policy if exists "own cred read" on public.user_llm_credentials;
create policy "own cred read"
on public.user_llm_credentials for select
to authenticated
using (user_id = auth.uid());

-- No authenticated insert/update/delete policies: credential writes go through server routes
-- that verify the user and use the service-role client after encrypting the secret.
