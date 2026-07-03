-- Zoho Agent Phase 1 schema
-- Run this in the Supabase SQL editor for the project.

create extension if not exists pgcrypto;

do $$
begin
  create type public.user_role as enum ('admin', 'operator', 'reviewer');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.user_status as enum ('active', 'invited', 'disabled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.action_mode as enum ('api', 'ui', 'helper');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.run_status as enum ('draft', 'validating', 'preview_ready', 'approved', 'running', 'paused', 'completed', 'failed', 'canceled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.run_item_status as enum ('pending', 'running', 'success', 'skipped', 'failed', 'needs_review');
exception when duplicate_object then null;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null unique,
  role public.user_role not null default 'operator',
  status public.user_status not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.zoho_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  zoho_org_id text not null default '890324941',
  zoho_domain text not null default 'crm.zoho.com',
  zoho_user_email text,
  connection_type text not null default 'browser_session',
  status text not null default 'unknown',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, zoho_org_id, zoho_domain)
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid references public.users(id) on delete set null,
  storage_path text,
  original_name text not null,
  mime_type text,
  file_kind text not null default 'upload',
  row_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  zoho_account_id text unique,
  zoho_url text,
  account_name text not null,
  website text,
  phone text,
  industry text,
  owner text,
  source text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  zoho_contact_id text unique,
  zoho_url text,
  account_id uuid references public.accounts(id) on delete set null,
  first_name text,
  last_name text,
  full_name text not null,
  email text,
  title text,
  phone text,
  mobile text,
  owner text,
  source text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  zoho_deal_id text unique,
  zoho_url text,
  account_id uuid references public.accounts(id) on delete set null,
  primary_contact_id uuid references public.contacts(id) on delete set null,
  deal_name text not null,
  stage text,
  next_step text,
  owner text,
  closing_date date,
  amount numeric,
  source text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  zoho_task_id text unique,
  related_record_type text not null,
  related_record_id uuid,
  subject text not null,
  due_date date,
  status text not null default 'open',
  owner text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scheduled_emails (
  id uuid primary key default gen_random_uuid(),
  zoho_email_id text unique,
  related_deal_id uuid references public.deals(id) on delete set null,
  related_contact_id uuid references public.contacts(id) on delete set null,
  to_email text not null,
  cc_emails text[] not null default '{}'::text[],
  subject text not null,
  body_hash text,
  schedule_date date not null,
  schedule_time time not null,
  status text not null default 'scheduled',
  zoho_url text,
  evidence_file_id uuid references public.files(id) on delete set null,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.zoho_field_meta (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('Accounts', 'Contacts', 'Deals', 'Tasks')),
  api_name text not null,
  label text not null,
  data_type text,
  picklist_values jsonb not null default '[]'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (module, api_name)
);

create table if not exists public.action_blocks (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  module text not null,
  mode public.action_mode not null,
  required_inputs jsonb not null default '[]'::jsonb,
  validations jsonb not null default '[]'::jsonb,
  execution_steps jsonb not null default '[]'::jsonb,
  verification jsonb not null default '[]'::jsonb,
  stop_conditions jsonb not null default '[]'::jsonb,
  default_config jsonb not null default '{}'::jsonb,
  admin_only boolean not null default false,
  version integer not null default 1,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug, version)
);

create table if not exists public.presets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  block_chain jsonb not null default '[]'::jsonb,
  default_run_parameters jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id) on delete set null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  preset_id uuid references public.presets(id) on delete set null,
  blocks jsonb not null default '[]'::jsonb,
  run_kind text not null default 'write' check (run_kind in ('read', 'write')),
  approval_required boolean not null default true,
  approved_at timestamptz,
  approved_by uuid references public.users(id) on delete set null,
  triggered_by uuid references public.users(id) on delete set null,
  status public.run_status not null default 'draft',
  input_file_id uuid references public.files(id) on delete set null,
  run_parameters jsonb not null default '{}'::jsonb,
  totals jsonb not null default '{"success":0,"skipped":0,"failed":0,"needs_review":0}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint read_runs_do_not_require_approval check (
    run_kind <> 'read' or approval_required = false
  )
);

create table if not exists public.workflow_run_items (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  row_number integer,
  record_type text,
  record_key text,
  block_slug text,
  status public.run_item_status not null default 'pending',
  action text,
  zoho_url text,
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  error_message text,
  evidence_file_id uuid references public.files(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  workflow_run_id uuid references public.workflow_runs(id) on delete set null,
  event_type text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists accounts_name_idx on public.accounts using gin (to_tsvector('simple', account_name));
create index if not exists contacts_full_name_idx on public.contacts using gin (to_tsvector('simple', full_name));
create index if not exists contacts_email_idx on public.contacts (lower(email));
create index if not exists deals_name_idx on public.deals using gin (to_tsvector('simple', deal_name));
create index if not exists workflow_runs_triggered_by_idx on public.workflow_runs (triggered_by, created_at desc);
create index if not exists workflow_run_items_run_idx on public.workflow_run_items (workflow_run_id, status);
create index if not exists audit_events_run_idx on public.audit_events (workflow_run_id, created_at desc);

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists zoho_connections_set_updated_at on public.zoho_connections;
create trigger zoho_connections_set_updated_at before update on public.zoho_connections
for each row execute function public.set_updated_at();

drop trigger if exists accounts_set_updated_at on public.accounts;
create trigger accounts_set_updated_at before update on public.accounts
for each row execute function public.set_updated_at();

drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at before update on public.contacts
for each row execute function public.set_updated_at();

drop trigger if exists deals_set_updated_at on public.deals;
create trigger deals_set_updated_at before update on public.deals
for each row execute function public.set_updated_at();

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks
for each row execute function public.set_updated_at();

drop trigger if exists scheduled_emails_set_updated_at on public.scheduled_emails;
create trigger scheduled_emails_set_updated_at before update on public.scheduled_emails
for each row execute function public.set_updated_at();

drop trigger if exists action_blocks_set_updated_at on public.action_blocks;
create trigger action_blocks_set_updated_at before update on public.action_blocks
for each row execute function public.set_updated_at();

drop trigger if exists presets_set_updated_at on public.presets;
create trigger presets_set_updated_at before update on public.presets
for each row execute function public.set_updated_at();

drop trigger if exists workflow_runs_set_updated_at on public.workflow_runs;
create trigger workflow_runs_set_updated_at before update on public.workflow_runs
for each row execute function public.set_updated_at();

drop trigger if exists workflow_run_items_set_updated_at on public.workflow_run_items;
create trigger workflow_run_items_set_updated_at before update on public.workflow_run_items
for each row execute function public.set_updated_at();

create or replace function public.current_app_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_app_role() = 'admin', false)
$$;

alter table public.users enable row level security;
alter table public.zoho_connections enable row level security;
alter table public.files enable row level security;
alter table public.accounts enable row level security;
alter table public.contacts enable row level security;
alter table public.deals enable row level security;
alter table public.tasks enable row level security;
alter table public.scheduled_emails enable row level security;
alter table public.zoho_field_meta enable row level security;
alter table public.action_blocks enable row level security;
alter table public.presets enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.workflow_run_items enable row level security;
alter table public.audit_events enable row level security;

drop policy if exists "users select self or admin" on public.users;
create policy "users select self or admin"
on public.users for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "users admin write" on public.users;
create policy "users admin write"
on public.users for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "connections own or admin" on public.zoho_connections;
create policy "connections own or admin"
on public.zoho_connections for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "records read authenticated" on public.accounts;
create policy "records read authenticated"
on public.accounts for select
to authenticated
using (true);

drop policy if exists "accounts admin write" on public.accounts;
create policy "accounts admin write"
on public.accounts for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "contacts read authenticated" on public.contacts;
create policy "contacts read authenticated"
on public.contacts for select
to authenticated
using (true);

drop policy if exists "contacts admin write" on public.contacts;
create policy "contacts admin write"
on public.contacts for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "deals read authenticated" on public.deals;
create policy "deals read authenticated"
on public.deals for select
to authenticated
using (true);

drop policy if exists "deals admin write" on public.deals;
create policy "deals admin write"
on public.deals for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "tasks read authenticated" on public.tasks;
create policy "tasks read authenticated"
on public.tasks for select
to authenticated
using (true);

drop policy if exists "tasks admin write" on public.tasks;
create policy "tasks admin write"
on public.tasks for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "scheduled emails read authenticated" on public.scheduled_emails;
create policy "scheduled emails read authenticated"
on public.scheduled_emails for select
to authenticated
using (true);

drop policy if exists "scheduled emails admin write" on public.scheduled_emails;
create policy "scheduled emails admin write"
on public.scheduled_emails for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "files own or admin read" on public.files;
create policy "files own or admin read"
on public.files for select
to authenticated
using (uploaded_by = auth.uid() or public.is_admin());

drop policy if exists "files own insert" on public.files;
create policy "files own insert"
on public.files for insert
to authenticated
with check (uploaded_by = auth.uid() or public.is_admin());

drop policy if exists "field meta read authenticated" on public.zoho_field_meta;
create policy "field meta read authenticated"
on public.zoho_field_meta for select
to authenticated
using (true);

drop policy if exists "field meta admin write" on public.zoho_field_meta;
create policy "field meta admin write"
on public.zoho_field_meta for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "action blocks read authenticated" on public.action_blocks;
create policy "action blocks read authenticated"
on public.action_blocks for select
to authenticated
using (true);

drop policy if exists "action blocks admin write" on public.action_blocks;
create policy "action blocks admin write"
on public.action_blocks for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "presets read authenticated" on public.presets;
create policy "presets read authenticated"
on public.presets for select
to authenticated
using (true);

drop policy if exists "presets admin write" on public.presets;
create policy "presets admin write"
on public.presets for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "runs owner reviewer admin read" on public.workflow_runs;
create policy "runs owner reviewer admin read"
on public.workflow_runs for select
to authenticated
using (
  triggered_by = auth.uid()
  or public.current_app_role() in ('admin', 'reviewer')
);

drop policy if exists "runs operator insert own" on public.workflow_runs;
create policy "runs operator insert own"
on public.workflow_runs for insert
to authenticated
with check (
  triggered_by = auth.uid()
  and public.current_app_role() in ('admin', 'operator')
);

drop policy if exists "runs owner update or admin" on public.workflow_runs;
create policy "runs owner update or admin"
on public.workflow_runs for update
to authenticated
using (
  public.is_admin()
  or (
    triggered_by = auth.uid()
    and public.current_app_role() = 'operator'
  )
)
with check (
  public.is_admin()
  or (
    triggered_by = auth.uid()
    and public.current_app_role() = 'operator'
  )
);

drop policy if exists "run items readable with run" on public.workflow_run_items;
create policy "run items readable with run"
on public.workflow_run_items for select
to authenticated
using (
  exists (
    select 1 from public.workflow_runs wr
    where wr.id = workflow_run_id
      and (wr.triggered_by = auth.uid() or public.current_app_role() in ('admin', 'reviewer'))
  )
);

drop policy if exists "run items writable with run" on public.workflow_run_items;
create policy "run items writable with run"
on public.workflow_run_items for all
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.workflow_runs wr
    where wr.id = workflow_run_id
      and wr.triggered_by = auth.uid()
      and public.current_app_role() = 'operator'
  )
)
with check (
  public.is_admin()
  or exists (
    select 1 from public.workflow_runs wr
    where wr.id = workflow_run_id
      and wr.triggered_by = auth.uid()
      and public.current_app_role() = 'operator'
  )
);

drop policy if exists "audit read with run" on public.audit_events;
create policy "audit read with run"
on public.audit_events for select
to authenticated
using (
  user_id = auth.uid()
  or public.current_app_role() in ('admin', 'reviewer')
  or exists (
    select 1 from public.workflow_runs wr
    where wr.id = workflow_run_id and wr.triggered_by = auth.uid()
  )
);

drop policy if exists "audit insert own" on public.audit_events;
create policy "audit insert own"
on public.audit_events for insert
to authenticated
with check (user_id = auth.uid() or public.is_admin());

insert into public.action_blocks
  (slug, name, module, mode, required_inputs, validations, execution_steps, verification, stop_conditions, default_config, admin_only, version, status)
values
  (
    'resolve_records',
    'Resolve records',
    'helper',
    'helper',
    '["record_keys"]',
    '["exact_match_first","starts_with_fallback","ambiguous_matches_need_review"]',
    '["api_search","children_enumeration","client_side_filter"]',
    '["resolved_ids_or_review_reasons"]',
    '["no_match","multiple_matches"]',
    '{"zoho_org_id":"890324941","zoho_domain":"crm.zoho.com"}',
    false,
    1,
    'active'
  ),
  (
    'update_deal_field',
    'Update deal field',
    'Deals',
    'api',
    '["deal_id_or_url","field_api_name","new_value"]',
    '["record_exists","field_api_name_valid","picklist_value_allowed","bulk_stage_admin_only","preview_confirmed"]',
    '["api_read_before","api_update","api_verify"]',
    '["read_back_after_value_equals_requested","before_after_logged"]',
    '["record_not_found","field_not_editable","invalid_picklist","failure_threshold_hit"]',
    '{"first_live_field":"Next_Step"}',
    false,
    1,
    'active'
  ),
  (
    'update_contact_fields',
    'Update contact fields',
    'Contacts',
    'api',
    '["contact_id_or_url","field_values"]',
    '["record_exists","field_api_names_valid","email_format_valid","skip_only_if_no_source_values"]',
    '["api_read_before","api_update","api_verify"]',
    '["read_back_after_values_equal_requested","before_after_logged"]',
    '["record_not_found","field_not_editable","failure_threshold_hit"]',
    '{}',
    false,
    1,
    'active'
  ),
  (
    'update_account_fields',
    'Update account fields',
    'Accounts',
    'api',
    '["account_id_or_url","field_values"]',
    '["record_exists","field_api_names_valid","picklist_value_allowed"]',
    '["api_read_before","api_update","api_verify"]',
    '["read_back_after_values_equal_requested","before_after_logged"]',
    '["record_not_found","field_not_editable","failure_threshold_hit"]',
    '{}',
    false,
    1,
    'active'
  ),
  (
    'change_owner',
    'Change owner',
    'Accounts|Contacts|Deals',
    'api',
    '["record_ids_or_urls","target_owner"]',
    '["owner_resolves_to_user_id","no_notification_email_default","cascade_explicit_only"]',
    '["api_read_before","api_update_owner","api_verify"]',
    '["owner_name_read_back_matches_target","counts_reported_per_module"]',
    '["owner_not_found","record_not_found","failure_threshold_hit"]',
    '{"send_notification_email":false,"cascade_related_records":false}',
    false,
    1,
    'active'
  ),
  (
    'add_tags',
    'Add tags',
    'Accounts|Contacts|Deals',
    'api',
    '["record_ids_or_urls","tag_names"]',
    '["record_exists","tag_names_present"]',
    '["api_tag_add","api_verify"]',
    '["tag_array_contains_requested_tags"]',
    '["record_not_found","failure_threshold_hit"]',
    '{}',
    false,
    1,
    'active'
  ),
  (
    'remove_tags',
    'Remove tags',
    'Accounts|Contacts|Deals',
    'api',
    '["record_ids_or_urls","tag_names"]',
    '["record_exists","tag_names_present"]',
    '["api_tag_remove","api_verify"]',
    '["tag_array_excludes_requested_tags"]',
    '["record_not_found","failure_threshold_hit"]',
    '{}',
    false,
    1,
    'active'
  ),
  (
    'create_task',
    'Create task',
    'Accounts|Contacts|Deals',
    'ui',
    '["record_url","subject","due_date"]',
    '["record_url_valid","subject_present","due_date_valid","duplicate_task_check"]',
    '["open_url","confirm_record_identity","open_activities","create_task","save_task"]',
    '["task_appears_in_open_activities"]',
    '["wrong_record","duplicate_task","verification_failed","logged_out"]',
    '{}',
    false,
    1,
    'active'
  ),
  (
    'complete_task',
    'Complete task',
    'Accounts|Contacts|Deals',
    'ui',
    '["record_url","subject"]',
    '["matching_open_task_exists","ambiguous_task_needs_review"]',
    '["open_url","find_task","mark_complete","retry_once_on_render_lag"]',
    '["task_removed_from_open_activities_or_closed_count_increased"]',
    '["task_not_found","ambiguous_task","verification_failed","logged_out"]',
    '{}',
    false,
    1,
    'active'
  ),
  (
    'schedule_email',
    'Schedule email',
    'Deals|Contacts',
    'ui',
    '["deal_url","contact_name","to_email","subject","body","schedule_date","schedule_time"]',
    '["deal_url_valid","email_format_valid","body_present","schedule_in_future","duplicate_scheduled_email_check","cc_confirmed"]',
    '["open_url","confirm_record_identity","compose_email","verify_before_schedule","schedule_and_close","verify_scheduled_tab"]',
    '["to_cc_chips_read_back","pre_schedule_screenshot_all_records","success_toast","scheduled_tab_time_matches"]',
    '["wrong_record","missing_email","duplicate_scheduled_email","verification_failed","logged_out"]',
    '{"default_cc":["ankur@klouddata.com"],"schedule_only":true}',
    false,
    1,
    'active'
  )
on conflict (slug, version)
do update set
  name = excluded.name,
  module = excluded.module,
  mode = excluded.mode,
  required_inputs = excluded.required_inputs,
  validations = excluded.validations,
  execution_steps = excluded.execution_steps,
  verification = excluded.verification,
  stop_conditions = excluded.stop_conditions,
  default_config = excluded.default_config,
  admin_only = excluded.admin_only,
  status = excluded.status,
  updated_at = now();

insert into public.presets
  (name, slug, description, block_chain, default_run_parameters, status)
values
  (
    'KD Blitz',
    'kd_blitz',
    'Create and complete campaign task, update Next Step, then schedule one Zoho email per contact.',
    '[
      {"slug":"create_task","config":{"subject_parameter":"task_subject","default_subject":"1st Email"}},
      {"slug":"complete_task","config":{"subject_parameter":"task_subject","default_subject":"1st Email"}},
      {"slug":"update_deal_field","config":{"field_api_name":"Next_Step","value_parameter":"next_step_value","default_value":"2nd Email"}},
      {"slug":"schedule_email","config":{"use_first_subject_option":true,"schedule_only":true}}
    ]',
    '{"cc":["ankur@klouddata.com"],"task_subject":"1st Email","next_step_value":"2nd Email"}',
    'active'
  ),
  (
    'Assign book of business',
    'assign_book_of_business',
    'Assign accounts and explicitly selected child contacts/deals to a target owner with per-module verification.',
    '[
      {"slug":"resolve_records","config":{"record_type":"Accounts","include_children":["Contacts","Deals"]}},
      {"slug":"change_owner","config":{"module":"Accounts"}},
      {"slug":"change_owner","config":{"module":"Contacts"}},
      {"slug":"change_owner","config":{"module":"Deals"}}
    ]',
    '{"send_notification_email":false,"cascade_related_records":true}',
    'active'
  )
on conflict (slug)
do update set
  name = excluded.name,
  description = excluded.description,
  block_chain = excluded.block_chain,
  default_run_parameters = excluded.default_run_parameters,
  status = excluded.status,
  updated_at = now();
