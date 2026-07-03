# Zoho Workflow Agent Project Plan

## 1. Project Summary

Build an internal Zoho-focused automation system for a small team. The system will maintain a structured database of Zoho records and workflow knowledge, then let users trigger specific Zoho actions through a web app.

The agent should not be a broad general-purpose assistant. It should be a controlled Zoho task executor that follows known workflows for:

- Email scheduling
- Task creation and completion
- Deal creation
- Deal field updates
- Account creation
- Account field updates
- Contact creation
- Contact field updates
- Verification and reporting

The agent will use the user's own logged-in Zoho session through a browser extension or browser-control layer. This avoids handling Zoho passwords directly and keeps actions tied to the user's own account.

## 2. Core Idea

Today, many Zoho operations are handled through files, manual steps, and repeated workflows. This project turns those repeatable workflows into a web-based operations system.

The system should:

1. Store clean Zoho-related data.
2. Store workflow instructions in a structured way.
3. Let a user choose a task from a web app.
4. Preview exactly what will happen before execution.
5. Use the user's active Zoho session to perform the task.
6. Verify the result.
7. Log success, skipped records, failures, and Zoho links.

## 3. Important Scope Decision

The first version is Zoho-only.

In scope:

- Zoho CRM
- Accounts
- Contacts
- Deals / Potentials
- Tasks
- Email scheduling inside Zoho
- Simple field updates
- Workflow execution logs
- CSV upload and batch processing

Out of scope for the first version:

- LinkedIn automation
- Gmail automation outside Zoho
- Sales Navigator
- Broad web research
- General AI browsing
- Multi-CRM support
- Fully autonomous decision making without user approval

## 4. Product Positioning

This should be treated as a CRM operations automation tool, not as a chat agent.

The best initial product description:

> A Zoho workflow executor for internal sales operations. Users select a known workflow, provide records or a batch file, review a preview, and the system performs the work in Zoho through their logged-in browser session while maintaining full logs.

## 5. Target Users

Initial users:

- 2 to 3 internal department users
- Users who already work inside Zoho
- Users who need to repeatedly schedule emails, create tasks, create deals, and update records

User roles:

### Admin

- Can manage workflows
- Can upload or edit master data
- Can view all run logs
- Can configure defaults
- Can approve risky workflows

### Operator

- Can run approved workflows
- Can upload CSVs
- Can preview runs
- Can execute workflows using their own Zoho login
- Can view their own run logs

### Reviewer

- Can inspect previews and logs
- Cannot execute actions unless granted permission

## 6. Main Workflows

### 6.1 Email Scheduling

Purpose:

Schedule personalized emails from Zoho deals or contacts.

Typical inputs:

- Contact list or CSV
- Deal URL or Deal ID
- Contact name
- Email address
- Subject
- Email body
- Schedule date
- Schedule time
- CC addresses
- Sender identity, based on logged-in Zoho user

Required validations:

- Deal exists
- Contact exists
- Contact belongs to the correct account or deal
- Recipient email is present
- Subject is present
- Body is present
- Schedule date and time are valid
- Duplicate scheduled email does not already exist

Execution steps:

1. Open the relevant Zoho deal or contact.
2. Confirm the record matches expected contact/account/deal.
3. Open the email composer.
4. Confirm recipient.
5. Add CC if needed.
6. Add subject.
7. Add email body.
8. Preserve or insert the correct signature.
9. Schedule the email.
10. Verify the scheduled email appears.
11. Update related fields if required, such as Next Step.
12. Log the result.

Success proof:

- Scheduled email exists in Zoho
- Subject matches expected subject
- Recipient matches expected contact
- Schedule date and time match expected schedule
- Run log contains Zoho record link

Stop conditions:

- Contact mismatch
- Account mismatch
- Missing email address
- Missing subject or body
- Existing scheduled duplicate found
- Zoho page does not load correctly

### 6.2 Task Creation

Purpose:

Create Zoho tasks against deals, accounts, or contacts.

Typical inputs:

- Record type: Deal, Account, or Contact
- Zoho record ID or URL
- Task subject
- Due date
- Owner
- Priority
- Status
- Description

Required validations:

- Target record exists
- Task subject is present
- Due date is valid
- Duplicate task does not already exist, if duplicate prevention is enabled

Execution steps:

1. Open target Zoho record.
2. Open Activities or Tasks section.
3. Create new task.
4. Fill subject, due date, owner, and notes.
5. Save task.
6. Verify task appears in Open Activities.
7. Log result.

Success proof:

- Task appears in Zoho
- Due date matches expected date
- Task owner matches expected owner, when applicable

### 6.3 Task Completion

Purpose:

Mark existing tasks as completed.

Typical inputs:

- Record URL or ID
- Task subject match
- Optional due date
- Optional owner

Required validations:

- Task exists
- Task is still open
- Task subject matches expected pattern

Execution steps:

1. Open target Zoho record.
2. Locate open task.
3. Confirm subject and due date.
4. Mark task complete.
5. Verify task is no longer in Open Activities.
6. Log result.

Stop conditions:

- More than one matching task found and no rule exists to choose one
- No matching task found
- Task already completed

### 6.4 Deal Creation

Purpose:

Create new Zoho deals for selected accounts and contacts.

Typical inputs:

- Account name or Account ID
- Contact name or Contact ID
- Deal name
- Stage
- Amount, if used
- Closing date
- Owner
- Next Step
- Source or campaign

Required validations:

- Account exists or should be created
- Contact exists or should be created
- Duplicate deal does not already exist
- Required Zoho fields are present

Execution steps:

1. Search or open account.
2. Search or open contact.
3. Check for existing matching deal.
4. Create deal.
5. Fill required fields.
6. Associate account and contact.
7. Save deal.
8. Verify deal URL and field values.
9. Log result.

Success proof:

- Deal exists
- Deal has correct account
- Deal has correct contact, if applicable
- Deal has correct stage and key fields
- Zoho deal link is stored

### 6.5 Deal Field Updates

Purpose:

Edit simple fields on existing deals.

Examples:

- Stage
- Next Step
- Owner
- Closing Date
- Campaign
- Description
- Custom fields

Required validations:

- Deal exists
- Current field value can be read
- New value is allowed
- User has permission to update the field

Execution steps:

1. Open deal.
2. Read current field value.
3. Compare to requested new value.
4. Update field.
5. Save.
6. Re-read field.
7. Log before and after.

Success proof:

- Field value after save equals requested value
- Before and after values stored in run log

### 6.6 Account Creation And Updates

Purpose:

Create or update Zoho accounts.

Typical inputs:

- Account name
- Website
- Industry
- Owner
- Phone
- Address
- Notes
- Custom fields

Required validations:

- Duplicate account check by name and website
- Required fields present
- Owner is valid

Execution steps:

1. Search for existing account.
2. If found, apply update rule.
3. If not found, create new account.
4. Save.
5. Verify account link and key fields.
6. Log result.

### 6.7 Contact Creation And Updates

Purpose:

Create or update Zoho contacts.

Typical inputs:

- First name
- Last name
- Email
- Title
- Phone
- Linked account
- Owner
- Contact source
- Custom fields

Required validations:

- Email format is valid
- Duplicate contact check by email
- Account exists or is created first
- Required fields present

Execution steps:

1. Search for contact by email.
2. If found, update allowed fields.
3. If not found, create new contact.
4. Link to account.
5. Save.
6. Verify contact link and fields.
7. Log result.

## 7. System Architecture

### 7.1 High-Level Components

1. Web app
2. Application backend
3. Database
4. Workflow library
5. Browser extension or local browser connector
6. Zoho executor
7. Verification engine
8. Run log and audit system

### 7.2 Web App

The web app is where users choose what they want to do.

Key screens:

- Login
- Dashboard
- Workflow selection
- CSV upload or saved list selection
- Input mapping
- Preview
- Execution progress
- Run result report
- Workflow history
- Record search
- Admin settings

### 7.3 Backend

The backend controls business logic.

Responsibilities:

- User authentication
- Permissions
- Workflow definitions
- CSV parsing
- Data validation
- Run creation
- Run state tracking
- Database updates
- Sending work instructions to the browser extension
- Receiving execution results
- Generating final reports

### 7.4 Database

The database stores Zoho data, workflow state, and logs.

Suggested core tables:

#### users

- id
- name
- email
- role
- status
- created_at
- updated_at

#### zoho_connections

- id
- user_id
- zoho_org_id
- zoho_user_email
- connection_type
- status
- last_seen_at

Note: if using browser session only, this does not need to store passwords or Zoho OAuth tokens.

#### accounts

- id
- zoho_account_id
- zoho_account_url
- account_name
- website
- owner
- status
- source
- raw_data
- created_at
- updated_at

#### contacts

- id
- zoho_contact_id
- zoho_contact_url
- account_id
- first_name
- last_name
- full_name
- email
- title
- phone
- owner
- source
- raw_data
- created_at
- updated_at

#### deals

- id
- zoho_deal_id
- zoho_deal_url
- account_id
- primary_contact_id
- deal_name
- stage
- next_step
- owner
- closing_date
- amount
- source
- raw_data
- created_at
- updated_at

#### tasks

- id
- zoho_task_id
- zoho_task_url
- related_record_type
- related_record_id
- subject
- due_date
- status
- owner
- raw_data
- created_at
- updated_at

#### scheduled_emails

- id
- zoho_email_id
- related_deal_id
- related_contact_id
- to_email
- cc_emails
- subject
- body_hash
- schedule_date
- schedule_time
- status
- zoho_url
- created_at
- updated_at

#### workflows

- id
- name
- slug
- description
- version
- status
- required_inputs
- validation_rules
- execution_steps
- verification_rules
- stop_conditions
- created_at
- updated_at

#### workflow_runs

- id
- workflow_id
- triggered_by_user_id
- status
- input_source
- input_file_name
- total_records
- success_count
- skipped_count
- failed_count
- started_at
- completed_at
- created_at

#### workflow_run_items

- id
- workflow_run_id
- row_number
- record_type
- record_key
- status
- action
- zoho_url
- before_data
- after_data
- error_message
- created_at
- updated_at

#### audit_events

- id
- user_id
- workflow_run_id
- event_type
- message
- metadata
- created_at

### 7.5 Workflow Library

Workflows should be stored in structured format, not only as plain text.

Each workflow should include:

- Name
- Purpose
- Inputs
- Required fields
- Optional fields
- Validation rules
- Duplicate checks
- Execution steps
- Verification steps
- Stop conditions
- Retry rules
- Output format

Example workflow fields:

```yaml
name: Schedule Zoho Email
slug: schedule_zoho_email
version: 1
record_type: deal_contact
required_inputs:
  - deal_url
  - contact_name
  - to_email
  - subject
  - body
  - schedule_date
  - schedule_time
optional_inputs:
  - cc_emails
  - next_step
validations:
  - confirm_deal_page_loads
  - confirm_contact_matches
  - confirm_no_duplicate_scheduled_email
execution:
  - open_deal
  - open_email_composer
  - fill_email
  - schedule_email
  - verify_email
  - update_next_step
stop_conditions:
  - contact_mismatch
  - missing_email
  - duplicate_email_found
```

## 8. Browser Extension / Browser Connector

The browser extension is the action layer. It executes steps inside the user's logged-in Zoho session.

Responsibilities:

- Detect active Zoho session
- Read current Zoho page state
- Navigate to Zoho record links
- Fill forms
- Click buttons
- Wait for pages and modals
- Verify changes
- Return structured results to backend

Important security rule:

The extension should only run on approved Zoho domains and only execute approved workflow steps.

Allowed domains:

- crm.zoho.com
- other Zoho CRM domains if the organization uses region-specific URLs

The extension should not have permission to automate unrelated websites in version 1.

## 9. Agent Behavior

The agent should be deterministic as much as possible.

It should:

- Select from known workflows
- Use structured input data
- Validate before acting
- Ask for approval before execution
- Stop on mismatches
- Avoid duplicate actions
- Log everything

It should not:

- Make broad assumptions
- Send or schedule emails without preview
- Create records without duplicate checks
- Continue after repeated Zoho errors
- Change unrelated fields
- Operate outside Zoho in version 1

## 10. Execution Lifecycle

### Step 1: User Selects Workflow

Example:

- Schedule emails
- Create tasks
- Create deals
- Update deal fields

### Step 2: User Provides Input

Options:

- Upload CSV
- Select saved batch
- Select existing records from database
- Paste rows manually

### Step 3: System Maps Fields

The app maps CSV columns to workflow fields.

Example:

- contact_name -> Contact Name
- account_name -> Account Name
- deal_url -> Deal URL
- schedule_time -> Schedule Time

### Step 4: Validation

The system checks:

- Required fields
- Bad emails
- Missing Zoho links
- Duplicate rows
- Existing completed actions
- Invalid dates

### Step 5: Preview

The preview should show:

- Records to process
- Actions to take
- Records that will be skipped
- Records with warnings
- Number of actions
- Estimated time

### Step 6: User Approval

User clicks:

- Run
- Dry run
- Cancel
- Fix input

### Step 7: Execution

The browser executor performs each item.

Each item gets one of these statuses:

- pending
- running
- success
- skipped
- failed
- needs_review

### Step 8: Verification

The executor checks Zoho after each action.

Examples:

- Scheduled email appears
- Task appears
- Task is completed
- Deal field changed
- Account was created
- Contact was linked to account

### Step 9: Final Report

The report includes:

- Total records
- Success count
- Skipped count
- Failed count
- Links to successful Zoho records
- Exact failure reasons
- Downloadable CSV result

## 11. Safety Rules

### Preview Required

No workflow should run without a preview.

### Dry Run Mode

Dry run should validate inputs and show planned actions without changing Zoho.

### Duplicate Prevention

Before creating or scheduling anything, check if it already exists.

### Stop Threshold

If too many failures happen, stop the run.

Example:

- Stop if 3 records fail consecutively
- Stop if more than 20 percent of records fail

### User Session Boundary

Actions happen in the user's own Zoho session.

This means:

- The action is tied to the logged-in user
- Existing Zoho permissions apply
- No shared Zoho password is needed

### Audit Log

Every action should be logged.

Minimum log:

- Who triggered it
- What workflow ran
- What record was touched
- What changed
- When it happened
- Whether verification passed

## 12. API vs Browser Automation

There are two possible execution methods.

### Option A: Zoho API

Pros:

- More stable than UI automation
- Faster
- Better for record creation and field updates
- Cleaner verification

Cons:

- Requires OAuth setup
- May require admin permissions
- Email scheduling through CRM UI may not be fully supported depending on Zoho APIs
- More setup complexity

### Option B: Browser Automation Through User Session

Pros:

- Uses existing user login
- Matches current manual workflow
- Easier for actions only available in UI
- No password handling
- Good for email scheduling flows

Cons:

- Zoho UI changes can break automation
- Slower
- Needs strong page-state verification
- Browser must be active and connected

### Recommended Approach

Use both over time:

1. Start with browser automation for workflows that already work manually in Zoho UI.
2. Use Zoho API later for stable backend operations like fetching records, duplicate checks, and simple field updates.

For version 1, prioritize browser automation because the current workflow knowledge already exists in that form.

## 13. MVP Recommendation

Do not build all workflows at once.

Recommended first MVP:

### MVP Workflow 1: Task Creation

Reason:

- Lower risk than email scheduling
- Easier to verify
- Useful across deals, accounts, and contacts
- Good test of browser executor and logging

### MVP Workflow 2: Email Scheduling

Reason:

- High value
- Repetitive
- Existing playbooks already exist
- Needs careful validation and preview

### MVP Workflow 3: Deal Field Updates

Reason:

- Simple but useful
- Builds confidence in editing existing Zoho records
- Useful for Next Step, stage, owner, and status fields

After these work reliably, add:

- Deal creation
- Account creation
- Contact creation
- Bulk updates
- Saved batches

## 14. Suggested Build Phases

### Phase 0: Workflow Inventory

Goal:

Convert current manual Zoho workflows into structured specs.

Tasks:

- Review existing workflow docs
- Review existing CSVs and result files
- Identify common columns
- Define exact inputs for each workflow
- Define success proof for each workflow
- Define stop conditions

Deliverables:

- Workflow inventory
- First workflow spec
- Data model draft

### Phase 1: Database And Admin Foundation

Goal:

Create the data layer and basic web app.

Tasks:

- Create database schema
- Create user roles
- Create record tables
- Create workflow tables
- Create run logs
- Build CSV upload
- Build field mapping

Deliverables:

- Working database
- Basic dashboard
- CSV upload and preview

### Phase 2: First Executor

Goal:

Run one Zoho workflow end to end.

Recommended first workflow:

- Create task on Zoho deal

Tasks:

- Build browser connector
- Open Zoho record link
- Create task
- Verify task
- Log result

Deliverables:

- One working workflow
- Result report
- Failure handling

### Phase 3: Email Scheduling

Goal:

Add the highest-value workflow.

Tasks:

- Parse email draft inputs
- Preview each email
- Validate contact/deal match
- Schedule email in Zoho
- Verify scheduled email
- Log output

Deliverables:

- Email scheduling workflow
- Duplicate email prevention
- Final report CSV

### Phase 4: Record Updates

Goal:

Support simple field edits.

Tasks:

- Add deal field update workflow
- Add account field update workflow
- Add contact field update workflow
- Log before and after values

Deliverables:

- Safe bulk update system
- Before and after reports

### Phase 5: Creation Workflows

Goal:

Create new Zoho records.

Tasks:

- Account creation
- Contact creation
- Deal creation
- Duplicate checks
- Record linking

Deliverables:

- Creation workflows
- New Zoho links stored in database

### Phase 6: Team Readiness

Goal:

Make the tool safe for multiple internal users.

Tasks:

- Role permissions
- User-specific browser sessions
- Admin review tools
- Audit log UI
- Error dashboard
- Workflow versioning

Deliverables:

- Team-ready internal system

## 15. User Experience Flow

Example: schedule emails.

1. User opens web app.
2. User chooses "Schedule Zoho Emails".
3. User uploads CSV or selects saved batch.
4. App maps columns.
5. App validates records.
6. App shows preview:
   - Contact
   - Account
   - Deal link
   - Email subject
   - Schedule time
   - Warnings
7. User clicks "Run".
8. Browser extension confirms Zoho session.
9. Agent processes records one by one.
10. User sees live progress.
11. Final report is saved.
12. Database records are updated.

## 16. What The Agent Needs To Know

For each workflow, the agent needs:

- Which Zoho module to use
- Which record to open
- Which fields to verify
- Which action to perform
- Which button or UI path to use
- How to verify success
- When to stop
- How to report the result

The agent should not infer major workflow rules from scratch during a run. It should load an approved workflow definition.

## 17. Data Import Strategy

The current workspace already contains many CSV and Excel files. The system should support importing these into the online database.

Likely import types:

- Contact upload CSVs
- Deal upload status CSVs
- Account link CSVs
- Deal link CSVs
- Email coverage reports
- Duplicate check reports
- Outreach batch files

Import process:

1. Upload file.
2. Detect file type.
3. Map columns.
4. Validate rows.
5. Match to existing database records.
6. Store source file reference.
7. Create import report.

## 18. Key Design Principle

The database should become the source of operational truth.

Files can still be uploaded and exported, but the system should gradually move away from depending on scattered CSVs for state.

Important record identifiers:

- Zoho Account ID
- Zoho Contact ID
- Zoho Deal ID
- Zoho URLs
- Email address
- Account name
- Contact full name

## 19. Error Handling

Common failure types:

- Zoho page did not load
- User is logged out
- Permission denied
- Record not found
- Contact mismatch
- Account mismatch
- Duplicate found
- Missing required field
- Zoho modal failed to open
- Save failed
- Verification failed

Each failure should include:

- Record row
- Workflow step
- Error type
- Human-readable message
- Screenshot or page snapshot if possible
- Suggested manual fix

## 20. Reporting

Each workflow run should produce:

- Web report
- Downloadable CSV
- Run log in database

Suggested output columns:

- input_row
- record_type
- contact_name
- account_name
- deal_name
- action_requested
- status
- zoho_url
- error_message
- completed_at

## 21. Security Considerations

Important rules:

- Do not store Zoho passwords.
- Use the user's active Zoho session.
- Limit extension permissions to Zoho domains.
- Require approval before execution.
- Store all run logs.
- Make destructive actions difficult or disabled in version 1.
- Avoid delete operations in early versions.
- Use roles and permissions.

Destructive operations to avoid at first:

- Deleting contacts
- Deleting accounts
- Deleting deals
- Mass overwriting critical fields
- Sending emails immediately

## 22. Technology Choices To Decide

These are not final decisions, but likely options.

### Web App

Options:

- Next.js
- React with backend API
- Simple internal dashboard

### Backend

Options:

- Node.js
- Python

### Database

Options:

- Postgres
- Supabase

### Browser Extension

Likely:

- Chrome extension
- Communicates with backend
- Runs only on Zoho CRM pages

### Execution Engine

Likely:

- Workflow runner in backend
- Browser extension performs page actions
- Backend stores state and logs

## 23. Biggest Risks

### Risk 1: Zoho UI Changes

Mitigation:

- Keep workflows modular
- Add verification after every step
- Prefer Zoho API where stable

### Risk 2: Duplicate Actions

Mitigation:

- Strong duplicate checks
- Run history
- Verification before action

### Risk 3: Bad Input Data

Mitigation:

- Validation and preview
- Required fields
- Row-level warnings

### Risk 4: User Trust

Mitigation:

- Clear preview
- Live progress
- Full logs
- No hidden actions

### Risk 5: Overbuilding

Mitigation:

- Start with one workflow
- Ship internal MVP
- Add workflows only after the previous one works reliably

## 24. First Practical Build Recommendation

Start with:

1. Workflow inventory
2. Database schema
3. CSV upload and preview
4. Task creation workflow
5. Execution log
6. Email scheduling workflow

Do not start with:

- Full AI chat
- Too many modules
- Multi-company support
- External tools like LinkedIn
- Complex autonomous planning

## 25. Questions To Confirm

These decisions are still needed:

1. Should the first workflow be task creation or email scheduling?
2. Should the first version use browser automation only, or also use Zoho API?
3. Should users upload CSVs first, or should the system pull records from Zoho first?
4. Should every run require approval after preview?
5. Which users will use version 1?
6. Which Zoho account/user should own scheduled emails?
7. Should the database store full email bodies or only hashes plus source references?
8. Should workflows be editable in the UI, or only by admins/developers at first?
9. Should the system support pausing and resuming long runs?
10. Should it create records automatically when missing, or stop and ask?

## 26. Proposed V1 Definition

V1 is successful if:

- A user can upload a CSV.
- The app validates required columns.
- The app shows a clear preview.
- The user approves the run.
- The browser extension uses the user's Zoho session.
- The agent creates or updates Zoho records for one approved workflow.
- The agent verifies the result.
- The app stores a full run log.
- The user can download a final report.

Recommended V1 workflow:

- Create tasks on Zoho deals from a CSV.

Recommended V1.1 workflow:

- Schedule emails on Zoho deals from a CSV or markdown draft source.

## 27. Long-Term Vision

The finished system becomes the operational layer between the sales team and Zoho.

Instead of manually handling scattered files and repeated CRM actions, the team uses one web app to:

- Choose a workflow
- Provide records
- Review the plan
- Run the action
- Get a verified report

The agent is valuable because it knows the team's Zoho workflows and uses the team's clean database, not because it guesses what to do.

