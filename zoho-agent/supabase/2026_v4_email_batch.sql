-- V4 batch email-scheduling ledger.
-- Run after supabase/schema.sql and supabase/2026_v2_agent.sql.
-- Additive and idempotent.

create table if not exists public.email_batch_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  batch_reference text not null,
  item_reference text not null,
  to_email text not null,
  to_name text,
  cc text[] not null default '{}',
  subject text not null,
  body text not null,
  schedule_date date not null,
  schedule_time text not null,
  timezone text not null,
  status text not null default 'pending'
    check (status in ('pending', 'resolving', 'scheduled', 'failed', 'skipped_duplicate')),
  deal_zoho_id text,
  deal_name text,
  deal_url text,
  contact_zoho_id text,
  error_message text,
  receipt jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, batch_reference, item_reference)
);

create index if not exists email_batch_items_user_batch_idx
on public.email_batch_items (user_id, batch_reference);

create index if not exists email_batch_items_user_status_idx
on public.email_batch_items (user_id, status);

-- Duplicate guard lookup: same user, same recipient/subject/date/time
-- already scheduled under any batch.
create index if not exists email_batch_items_dup_guard_idx
on public.email_batch_items (user_id, to_email, subject, schedule_date, schedule_time)
where status = 'scheduled';

drop trigger if exists email_batch_items_set_updated_at on public.email_batch_items;
create trigger email_batch_items_set_updated_at before update on public.email_batch_items
for each row execute function public.set_updated_at();

alter table public.email_batch_items enable row level security;

drop policy if exists "email batch items own or admin read" on public.email_batch_items;
create policy "email batch items own or admin read"
on public.email_batch_items for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

-- email_batch_items writes are intentionally omitted from RLS policies. They
-- are written by the server-side batch tool with the service-role key after
-- the caller/session/user have been authorized; the owning user only ever
-- reads through the select policy above.
