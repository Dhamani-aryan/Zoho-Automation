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
  'Each item needs contact name, email, account/company, persona, title, deal URL/id, first subject option, body ending at Best,, schedule date/time, and CC rules. For imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md parse the header: IT/Technical gets Email A, Finance gets Email B, Leadership gets Email A; use subject option 1; CC prashant.sharma@klouddata.com and ankur@klouddata.com; schedule time is 8:00 PM; body boundary is Best, and Zoho signature stays below. The only permitted question for that file is the TBD schedule date.',
  'Use API/browser_eval for data prep, resolving deal/contact ids, duplicate checks, and verification where available. For UI compose/schedule, open the deal Potential URL, navigate to Emails, click Compose Email, fill recipient/subject/body/CC, schedule, then verify in Scheduled. Schedule never send immediately. For undo, scheduled emails are non-revertible in scope; document manual path: open the related deal, Emails, Scheduled tab, find the matching recipient/subject/time, and use Zoho UI delete/cancel manually.',
  $guide$Selector map from KD Blitz playbook section 9: Compose Email button is a button with text Compose Email. To input #ceToAddr_1; To chips [id^="ceToAddrDetails"] li.selectedEmail; remove stale chips via .closeIconB. Subject #ceSubject_1. Cc link is small text Cc; Cc input #ceCCAddr_1; Cc chips [id^="ceCCAddrDetails"]. Body editor is iframe frame_selector #z_editor with inner #editorDiv and signature #ecw_signature. Use CDP trusted input and a real Enter key to commit To and each CC chip. Schedule button is text Schedule, last visible match width < 160; popup time #schTimeMail with zero-padded option like 08:00 PM; date #startDate or #bstDate; confirm button text Schedule & Close.

Exact browser_eval body recipe (pass frame_selector #z_editor and define BODY as an array of lines ending at Best,):
const ed = document.getElementById("editorDiv");
const sig = document.getElementById("ecw_signature");
if (!ed || !sig || !ed.contains(sig)) throw new Error("Composer editor/signature missing");
let anchor = sig;
while (anchor.parentElement && anchor.parentElement !== ed) anchor = anchor.parentElement;
if (anchor.parentElement !== ed) throw new Error("Signature anchor is outside editor");
for (const node of [...ed.childNodes]) { if (node === anchor) break; node.remove(); }
const lines = [...BODY];
while (lines[0]?.trim() === "") lines.shift();
while (lines.at(-1)?.trim() === "") lines.pop();
const style = "font-family: Verdana, Geneva, sans-serif; font-size: 13.33px;";
const container = document.createElement("div");
for (const line of lines) {
  const div = document.createElement("div");
  div.style.cssText = style;
  if (line === "") div.appendChild(document.createElement("br")); else div.textContent = line;
  container.appendChild(div);
}
for (let i = 0; i < 2; i += 1) {
  const div = document.createElement("div");
  div.style.cssText = style;
  div.appendChild(document.createElement("br"));
  container.appendChild(div);
}
ed.insertBefore(container, anchor);
ed.dispatchEvent(new Event("input", { bubbles: true }));
return {
  body_text: container.innerText,
  signature_present: sig.isConnected && ed.contains(sig),
  signature_after_body: Boolean(container.compareDocumentPosition(sig) & Node.DOCUMENT_POSITION_FOLLOWING)
};

Never assign #editorDiv innerHTML/textContent, call replaceChildren, or use ui_step fill_field on the whole editor.$guide$,
  'Schedule means schedule, never send. Zoho may leave a default To chip, so clear chips first and read them back. Date format in task/email UI can be like Jun 22, 2026. Multiple subject options require option 1 unless the user explicitly overrides. The body in the drafts file already ends at Best,; never add a typed signature because #ecw_signature is already present. Correction 2026-07-10: whole-editor replacement removed the live signature; always use the anchored insertion recipe and require signature_present=true plus signature_after_body=true.',
  'Before scheduling: the composer-fill eval must return a JSON object containing exact To and Cc chip values, subject, body text/spacing, and signature_present=true; if it returns no value, observe/read back before retrying because the composer may already be changed. Screenshot evidence should show correct recipient(s), first subject, Hi {FirstName} with no blank line above, two blank lines before signature. After scheduling: confirm success toast "Your mail has been scheduled successfully" and verify the email appears in the Scheduled tab at the requested date/time. Report counts, failures, screenshots/evidence ids, and non-revertible scheduled-email undo notes.',
  'Stop on missing email/subject/body/date/time, wrong deal/contact/account, duplicate scheduled email, To/Cc chip mismatch, composer/iframe not found, logged out, immediate-send risk, or Scheduled-tab verification mismatch.',
  '[{"name":"draft_file","description":"Markdown file with contact email drafts","example":"imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md"},{"name":"schedule_date","description":"Only question allowed when the source says TBD","example":"2026-07-22"},{"name":"schedule_time","description":"Time from header, normally 8:00 PM","example":"8:00 PM"},{"name":"cc","description":"CC addresses from header","example":["prashant.sharma@klouddata.com","ankur@klouddata.com"]}]'::jsonb
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
on conflict (name) do update set
  intent = excluded.intent,
  preconditions = excluded.preconditions,
  method_api = excluded.method_api,
  method_ui = excluded.method_ui,
  gotchas = excluded.gotchas,
  verification = excluded.verification,
  stop_conditions = excluded.stop_conditions,
  params = excluded.params,
  version = case
    when row(public.skill_guides.intent, public.skill_guides.preconditions, public.skill_guides.method_api, public.skill_guides.method_ui, public.skill_guides.gotchas, public.skill_guides.verification, public.skill_guides.stop_conditions, public.skill_guides.params)
      is distinct from row(excluded.intent, excluded.preconditions, excluded.method_api, excluded.method_ui, excluded.gotchas, excluded.verification, excluded.stop_conditions, excluded.params)
    then public.skill_guides.version + 1
    else public.skill_guides.version
  end,
  updated_at = case
    when row(public.skill_guides.intent, public.skill_guides.preconditions, public.skill_guides.method_api, public.skill_guides.method_ui, public.skill_guides.gotchas, public.skill_guides.verification, public.skill_guides.stop_conditions, public.skill_guides.params)
      is distinct from row(excluded.intent, excluded.preconditions, excluded.method_api, excluded.method_ui, excluded.gotchas, excluded.verification, excluded.stop_conditions, excluded.params)
    then now()
    else public.skill_guides.updated_at
  end;
