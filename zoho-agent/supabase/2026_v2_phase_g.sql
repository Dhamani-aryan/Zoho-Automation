-- V2 Phase G: task-autonomous agent.
-- Run after supabase/2026_v2_phase_f.sql and the Phase F follow-up commits.
-- Additive and idempotent.

alter table public.users
  add column if not exists approvals_enabled boolean not null default false;

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

alter table public.pending_approvals
  add column if not exists task_order_id uuid references public.task_orders(id) on delete set null;

create table if not exists public.skill_guides (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  intent text not null,
  preconditions text not null default '',
  method_api text not null default '',
  method_ui text not null default '',
  gotchas text not null default '',
  verification text not null default '',
  stop_conditions text not null default '',
  params jsonb not null default '[]'::jsonb,
  version int not null default 1,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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

create index if not exists skill_guides_updated_idx
on public.skill_guides (updated_at desc);

drop trigger if exists skill_guides_set_updated_at on public.skill_guides;
create trigger skill_guides_set_updated_at before update on public.skill_guides
for each row execute function public.set_updated_at();

alter table public.task_orders enable row level security;
alter table public.skill_guides enable row level security;

drop policy if exists "task orders own or admin read" on public.task_orders;
create policy "task orders own or admin read"
on public.task_orders for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

-- task_orders writes are intentionally omitted from RLS policies. They are
-- written by server routes/tools with the service-role key after session,
-- role, and owner checks.

drop policy if exists "skill guides authenticated read" on public.skill_guides;
create policy "skill guides authenticated read"
on public.skill_guides for select
to authenticated
using (true);

-- skill_guides writes are intentionally omitted from RLS policies. They are
-- written by server routes/tools with the service-role key after role checks
-- and save confirmations.

insert into public.skill_guides (
  name, intent, preconditions, method_api, method_ui, gotchas, verification, stop_conditions, params
) values
(
  'zoho-facts',
  'Shared Zoho CRM facts for all guides: org id, auth headers, module names, URL forms, write/read bases, and safety defaults.',
  'A logged-in crm.zoho.com tab exists. Use only org 890324941 and modules Accounts, Contacts, Deals unless a later approved phase expands scope.',
  'Read token with document.getElementById(''token'')?.value. Headers: X-ZCSRF-TOKEN=crmcsrfparam=token, X-CRM-ORG=890324941, X-Requested-With=XMLHttpRequest. Reads/search use https://crm.zoho.com/crm/v3. Writes use https://crm.zoho.com/crm/v2.2 with Content-Type application/json. Always fetch with credentials:"include".',
  'Use browser_observe and ui_step only when API does not fit or the user asks to show/click. CDP coordinates are CSS pixels from getBoundingClientRect, not screenshot pixels.',
  'Deals API module is Deals but URL tab is Potentials. HTTP 204 means no match. Criteria values with parentheses/special chars can 400; use starts_with prefix and filter client-side. Chunk writes at 100. Writes are idempotent and must be verified.',
  'After writes, re-read the record or relevant list and compare exact requested values. Report counts and links.',
  'Stop on logged out token missing, identity mismatch, required data missing, duplicate/no-rule match, Zoho errors, 3 consecutive failures, or >20 percent failures.',
  '[{"name":"module","description":"Accounts, Contacts, or Deals","example":"Deals"}]'::jsonb
),
(
  'deals-editing',
  'Edit Deal records: owner, allowed fields, tags, and deal-specific lookup/read tasks.',
  'Resolve exact Deal id(s). Deal_Name cannot be changed. Stage is admin-only. Lookup reparenting is out of scope unless explicitly approved and supported.',
  'Search: GET /crm/v3/Deals/search?criteria=(Deal_Name:equals:NAME)&fields=Deal_Name,Account_Name,Stage,Owner,id&per_page=200. Account-based search is often best because deals are named "{Account} | SAP Cloud ERP". Read: GET /crm/v3/Deals/{id}?fields=Deal_Name,Owner,Stage,Amount,Closing_Date,Next_Step,Tag. Field write: PUT /crm/v2.2/Deals body {data:[{id, Next_Step:value, Stage:value, Owner:{id:userId}}]}. Tags: POST /crm/v2.2/Deals/{id}/actions/add_tags or remove_tags, or bulk actions/add_tags?ids=...&tag_names=....',
  'For single-record UI inspection, open https://crm.zoho.com/crm/org890324941/tab/Potentials/{dealId}, observe, use field labels as landmarks, and verify with read-back. Change Owner is not in More Options; prefer API.',
  'Special characters in Deal_Name criteria can break search. Use starts_with and filter. Account_Name and Contact_Name are lookup objects. Related list entries are li.dv_leftLi, not left module nav.',
  'Re-read /crm/v3/Deals/{id} with fields changed plus Deal_Name and Owner/Tag. Confirm each value equals requested and include the Potential URL.',
  'Stop on multiple deal matches without a rule, wrong account/contact, forbidden field, unknown picklist, or failed read-back.',
  '[{"name":"deal_id","description":"Zoho Deal id","example":"6834250000003329005"},{"name":"field","description":"Deal field API name","example":"Next_Step"}]'::jsonb
),
(
  'contacts-editing',
  'Edit Contact records and enumerate contacts under accounts.',
  'Resolve exact Contact id(s) and confirm the account/person identity. Full_Name is read-only.',
  'Search by name: GET /crm/v3/Contacts/search?criteria=((First_Name:equals:F)and(Last_Name:equals:L))&fields=Full_Name,First_Name,Last_Name,Account_Name,Title,Email,Phone,Mobile,id&per_page=20. All contacts for account: GET /crm/v3/Accounts/{accountId}/Contacts?fields=Full_Name,Title,Email,Phone,Mobile,id&per_page=200. Read: GET /crm/v3/Contacts/{id}?fields=Full_Name,Owner,Email,Phone,Mobile,Title,Account_Name,Tag. Write: PUT /crm/v2.2/Contacts body {data:[{id, Phone:value, Mobile:value, Owner:{id:userId}}]}. Tags use Contacts actions/add_tags or remove_tags.',
  'For UI fallback open /tab/Contacts/{contactId}; account related-list contact edit icons are hover-reveal controls. Use browser_observe and CDP mouse if needed.',
  'Validate Email shape and dates. Account_Name is lookup. Use account child endpoint for coverage reports and account-scoped batches.',
  'Re-read Contacts/{id}; confirm fields, owner, or tags. Include contact URL and account when relevant.',
  'Stop on missing email/phone required by task, contact/account mismatch, duplicate contacts with no rule, or failed read-back.',
  '[{"name":"contact_id","description":"Zoho Contact id","example":"6834250000001111111"},{"name":"account_id","description":"Zoho Account id for child enumeration","example":"6834250000002222222"}]'::jsonb
),
(
  'accounts-editing',
  'Edit Account records and cascade account-owned work to child Contacts and Deals when explicitly requested.',
  'Resolve exact Account id(s). For book-of-business moves, scope must name whether children are included.',
  'Search: GET /crm/v3/Accounts/search?criteria=(Account_Name:equals:ACCOUNT)&fields=Account_Name,Owner,id&per_page=200; fallback starts_with and filter. Read: GET /crm/v3/Accounts/{id}?fields=Account_Name,Owner,Phone,Website,Industry,Annual_Revenue,Billing_City,Billing_State,Tag. Children: /crm/v3/Accounts/{id}/Contacts and /Deals. Write: PUT /crm/v2.2/Accounts body {data:[{id, Owner:{id:userId}, Phone:value, Website:value}]}. Tags use Accounts actions/add_tags or remove_tags. For owner book moves, update Accounts, Contacts, and Deals explicitly and verify each module.',
  'For UI fallback open /tab/Accounts/{accountId}. Related lists are li.dv_leftLi entries like Contacts 5 or Deals 1, not global sidebar nav. Hover rows to reveal inline edit icons.',
  'Owner change via API does not cascade to child records. Parent_Account is lookup. Industry and Account_Type are picklists; discover with fields metadata.',
  'Re-read Accounts/{id}; for cascades, re-read child Contacts/Deals. Report per-module counts.',
  'Stop on account ambiguity, missing cascade scope, forbidden lookup changes, unknown picklist, or any module verification failure.',
  '[{"name":"account_id","description":"Zoho Account id","example":"6834250000002222222"},{"name":"owner_name","description":"Known CRM owner name","example":"Linda Spione"}]'::jsonb
),
(
  'email-scheduling',
  'Schedule KD Blitz style one-to-one emails from draft markdown/contact rows. Schedule never send immediately.',
  'Each item needs contact name, email, account/company, deal URL/id, subject, body, schedule date/time, and timezone rule. Missing recipient/subject/body/date/time must stop or skip per approved plan.',
  'Use API/browser_eval for data prep, resolving deal/contact ids, duplicate checks, and verification where available. For the UI-only compose/schedule flow, open deal Potential URL, navigate to Emails/Send Email/Compose, fill recipient/subject/body, choose schedule, and verify in Scheduled view. Preserve CC rules from the source draft; for KD Blitz CC ankur@klouddata.com only when the playbook says so.',
  'Use browser_observe to find Emails/Send Email/Compose and scheduler controls. Use CDP trusted input for composer/editor iframe, hover-reveal controls, and Enter-to-commit. The email body editor may be contentEditable/iframe; use frame_selector when needed.',
  'Schedule means schedule, never send. Verify contact/deal identity before composing. Date format in task/email UI can be like Jun 22, 2026. Multiple subject options require choosing the approved one.',
  'Confirm the scheduled email exists with correct recipient, subject, scheduled date/time, and related deal/contact. Report success/skipped/failed counts and links.',
  'Stop on missing email/subject/body/date/time, wrong deal/contact/account, duplicate scheduled email, logged out, composer not found, or verification mismatch.',
  '[{"name":"draft_file","description":"Markdown file with contact email drafts","example":"KD Blitz Batch 5 All Contacts Email Drafts.md"},{"name":"schedule_date","description":"Schedule date","example":"2026-07-22"}]'::jsonb
),
(
  'task-create-complete',
  'Create or complete Zoho CRM Tasks related to Accounts, Contacts, or Deals.',
  'Resolve parent record and exact task subject/date/status. No deletes. Duplicate/open task checks required before creation.',
  'Prefer internal APIs if task endpoints are confirmed in the live page. Otherwise use UI fallback: open parent record, use Add New or Activities/Open Activities, choose Task, fill #task_subject and #Crm_Tasks_DUEDATE, save, then verify task appears. For completion, find the open task by subject/parent and mark complete only if identity matches.',
  'Use browser_observe to locate Activities, Add New, Task, and task rows. Use CDP input for hover/inline controls when DOM events do not work.',
  'Task UI selectors seen in playbook: #task_subject and #Crm_Tasks_DUEDATE. Task option may be li/div text Task with robotoRegular/fillAspLi classes. UI may move, so observe first.',
  'Verify created task appears in Open Activities with subject/date/parent. Verify completed task is no longer open or appears completed where Zoho shows closed activities.',
  'Stop on duplicate task, parent mismatch, missing subject/due date, more than one matching open task, or completion not verified.',
  '[{"name":"record_url","description":"Parent Zoho record URL","example":"https://crm.zoho.com/crm/org890324941/tab/Potentials/6834250000003329005"},{"name":"task_subject","description":"Task subject","example":"Follow up"}]'::jsonb
)
on conflict (name) do nothing;
