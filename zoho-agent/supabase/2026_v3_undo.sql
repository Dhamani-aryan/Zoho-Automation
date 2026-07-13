create table if not exists public.undo_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  session_id uuid references public.agent_sessions(id) on delete set null,
  module text not null check (module in ('Accounts', 'Contacts', 'Deals')),
  zoho_id text not null,
  before_fields jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists undo_log_user_record_created_idx
on public.undo_log (user_id, module, zoho_id, created_at desc);

create index if not exists undo_log_session_created_idx
on public.undo_log (session_id, created_at desc);

alter table public.undo_log enable row level security;

drop policy if exists "undo log own or admin read" on public.undo_log;
create policy "undo log own or admin read"
on public.undo_log for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

-- undo_log writes are intentionally omitted from RLS policies. They are
-- written by server tools with the service-role key immediately before Zoho
-- writes, after the session and user have been authorized.
