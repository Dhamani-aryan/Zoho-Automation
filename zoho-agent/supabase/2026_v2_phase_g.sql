-- V2 Phase G: task-autonomous agent.
-- Run after supabase/2026_v2_phase_f.sql and the Phase F follow-up commits.
-- Additive and idempotent.

alter table public.tool_jobs
  add column if not exists approval_id uuid references public.pending_approvals(id) on delete set null;

create index if not exists tool_jobs_approval_idx
on public.tool_jobs (approval_id);

create index if not exists tool_jobs_session_approval_idx
on public.tool_jobs (session_id, approval_id);

create table if not exists public.task_orders (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  goal text not null,
  plan jsonb not null default '{}'::jsonb,
  scope text not null check (scope in ('read', 'write')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'expired', 'completed', 'failed')),
  budget jsonb not null default '{}'::jsonb,
  report jsonb,
  decided_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.tool_jobs
  add column if not exists task_order_id uuid references public.task_orders(id) on delete set null;

create index if not exists task_orders_session_status_idx
on public.task_orders (session_id, status, created_at desc);

create index if not exists task_orders_user_status_idx
on public.task_orders (user_id, status, created_at desc);

create unique index if not exists task_orders_one_active_per_session_idx
on public.task_orders (session_id)
where status = 'approved';

create index if not exists tool_jobs_task_order_idx
on public.tool_jobs (task_order_id);

alter table public.task_orders enable row level security;

drop policy if exists "task orders own or admin read" on public.task_orders;
create policy "task orders own or admin read"
on public.task_orders for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

-- task_orders writes are intentionally omitted from RLS policies. They are
-- written by server routes/tools with the service-role key after session,
-- role, and owner checks.
