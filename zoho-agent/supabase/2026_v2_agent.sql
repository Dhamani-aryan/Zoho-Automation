-- V2 tool-calling agent migration.
-- Run after supabase/schema.sql, supabase/2026_phase2.sql, and supabase/2026_phase3.sql.
-- Additive and idempotent.

create table if not exists public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text,
  tool_name text,
  tool_args jsonb,
  tool_result jsonb,
  tool_tier int,
  created_at timestamptz not null default now()
);

create table if not exists public.tool_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  tool_name text not null,
  args jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'expired')),
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.pending_approvals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  tool_name text not null,
  args jsonb not null,
  summary jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.tool_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  name text not null,
  purpose text not null,
  example_call jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists public.ui_workflows (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.users(id) on delete set null,
  name text not null unique,
  description text,
  params jsonb not null default '[]'::jsonb,
  steps jsonb not null,
  effect text not null default 'read' check (effect in ('read', 'write')),
  trusted boolean not null default false,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_sessions_user_idx
on public.agent_sessions (user_id, updated_at desc);

create index if not exists agent_messages_session_idx
on public.agent_messages (session_id, created_at);

create index if not exists tool_jobs_user_status_idx
on public.tool_jobs (user_id, status, created_at);

create index if not exists tool_jobs_session_status_idx
on public.tool_jobs (session_id, status, created_at);

create index if not exists pending_approvals_user_status_idx
on public.pending_approvals (user_id, status, created_at);

create index if not exists tool_requests_status_idx
on public.tool_requests (status, created_at desc);

drop trigger if exists agent_sessions_set_updated_at on public.agent_sessions;
create trigger agent_sessions_set_updated_at before update on public.agent_sessions
for each row execute function public.set_updated_at();

drop trigger if exists ui_workflows_set_updated_at on public.ui_workflows;
create trigger ui_workflows_set_updated_at before update on public.ui_workflows
for each row execute function public.set_updated_at();

alter table public.agent_sessions enable row level security;
alter table public.agent_messages enable row level security;
alter table public.tool_jobs enable row level security;
alter table public.pending_approvals enable row level security;
alter table public.tool_requests enable row level security;
alter table public.ui_workflows enable row level security;

drop policy if exists "agent sessions own or admin read" on public.agent_sessions;
create policy "agent sessions own or admin read"
on public.agent_sessions for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "agent sessions own insert" on public.agent_sessions;
create policy "agent sessions own insert"
on public.agent_sessions for insert
to authenticated
with check (user_id = auth.uid() and public.current_app_role() in ('admin', 'operator'));

drop policy if exists "agent sessions own update or admin" on public.agent_sessions;
create policy "agent sessions own update or admin"
on public.agent_sessions for update
to authenticated
using (public.is_admin() or user_id = auth.uid())
with check (public.is_admin() or user_id = auth.uid());

drop policy if exists "agent messages readable with session" on public.agent_messages;
create policy "agent messages readable with session"
on public.agent_messages for select
to authenticated
using (
  exists (
    select 1 from public.agent_sessions s
    where s.id = session_id
      and (s.user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "agent messages insert with own session" on public.agent_messages;
create policy "agent messages insert with own session"
on public.agent_messages for insert
to authenticated
with check (
  exists (
    select 1 from public.agent_sessions s
    where s.id = session_id
      and s.user_id = auth.uid()
      and public.current_app_role() in ('admin', 'operator')
  )
);

drop policy if exists "tool jobs own or admin read" on public.tool_jobs;
create policy "tool jobs own or admin read"
on public.tool_jobs for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "pending approvals own or admin read" on public.pending_approvals;
create policy "pending approvals own or admin read"
on public.pending_approvals for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "tool requests own or admin read" on public.tool_requests;
create policy "tool requests own or admin read"
on public.tool_requests for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "tool requests own insert" on public.tool_requests;
create policy "tool requests own insert"
on public.tool_requests for insert
to authenticated
with check (user_id = auth.uid() and public.current_app_role() in ('admin', 'operator'));

drop policy if exists "tool requests admin update" on public.tool_requests;
create policy "tool requests admin update"
on public.tool_requests for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "ui workflows authenticated read" on public.ui_workflows;
create policy "ui workflows authenticated read"
on public.ui_workflows for select
to authenticated
using (true);

drop policy if exists "ui workflows own insert" on public.ui_workflows;
create policy "ui workflows own insert"
on public.ui_workflows for insert
to authenticated
with check (created_by = auth.uid() and public.current_app_role() in ('admin', 'operator'));

drop policy if exists "ui workflows own update or admin" on public.ui_workflows;
create policy "ui workflows own update or admin"
on public.ui_workflows for update
to authenticated
using (public.is_admin() or created_by = auth.uid())
with check (public.is_admin() or created_by = auth.uid());

-- tool_jobs and pending_approvals writes are intentionally omitted from RLS
-- policies. They are written by server routes with the service-role key after
-- caller/session/role checks, then read by the owning user through RLS.
