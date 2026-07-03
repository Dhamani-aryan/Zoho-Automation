# HeySnap / Snap Zoho Workflow Guide

## 1. Purpose Of This Document

This document explains:

- Who Snap is
- How Snap works
- How you use Snap today for Zoho CRM work
- What the current human-plus-agent workflow looks like
- Which parts should inspire the future Zoho-only workflow agent
- What should be automated, stored, verified, and logged

This is written as a practical workflow reference for the Zoho automation project.

## 2. Who Snap Is

Snap is the assistant inside HeySnap.

In your current setup, Snap acts like a desk-work agent that can:

- Read files in your workspace
- Understand CSV, Excel, Markdown, PDF, Word, and other business files
- Run scripts and data checks
- Operate a browser when needed
- Use your logged-in browser session for web apps like Zoho
- Follow existing workflow documents
- Create new workflow documents
- Clean data
- Prepare CRM upload files
- Schedule or assist with Zoho actions
- Verify work before reporting completion

For your Zoho work, Snap is mainly used as a CRM operations assistant.

Snap does not just answer questions. The useful part is that Snap can actually inspect the files, understand the workflow, perform steps, check results, and create reports.

## 3. How Snap Works Architecturally

Snap works through several layers.

### 3.1 Reasoning Layer

This is the part that reads your request and decides what needs to happen.

Examples:

- Understand that a CSV is meant for Zoho contact upload
- Notice that a deal upload file needs account matching
- Decide that a scheduled email workflow needs contact names, deal links, subjects, bodies, dates, and times
- Detect when a record should be skipped because required data is missing
- Decide which workflow document applies to the current task

### 3.2 Workspace Layer

Snap can access your workspace files.

For this Zoho project, the main workspace is:

`/workspace/Zoho`

Important current folder:

`/workspace/Zoho/Deal | Pdf`

This folder contains many of the current Zoho work assets:

- Contact files
- Account files
- Deal files
- Upload CSVs
- Email drafts
- Workflow documents
- Audit reports
- Zoho links
- Scheduling playbooks
- Result files

Snap uses these files as the source material for the Zoho work.

### 3.3 Tool Layer

Snap can use tools on the cloud machine to process work.

Examples:

- Read and compare CSV files
- Clean spreadsheets
- Generate upload files
- Parse Markdown email drafts
- Create reports
- Convert files
- Validate row counts
- Find duplicates
- Check missing fields

The user usually does not need to see these internal steps. The important output is the final clean file, report, or completed Zoho action.

### 3.4 Browser Layer

Snap can operate a real Chrome browser connected to the user's environment.

This matters because Zoho is usually logged in through the user's browser profile.

Benefits:

- No need to share Zoho password
- Uses the user's existing Zoho login
- Uses the user's existing permissions
- Works with Zoho UI just like a person would
- Can open Zoho record links directly
- Can fill forms, click buttons, schedule emails, and verify pages

This browser behavior is one of the most important references for the future Zoho agent.

### 3.5 Verification Layer

Snap should verify before saying work is complete.

For Zoho work, verification can mean:

- Check that a scheduled email appears in Zoho
- Check that a task was created
- Check that a task was completed
- Check that a deal stage or Next Step changed
- Check that a contact was linked to the right account
- Check that a generated CSV has the expected columns and rows
- Check that skipped records are clearly documented

This verification mindset should be copied into the future product.

## 4. How You Currently Use Snap For Zoho Work

Your current usage pattern is something like this:

1. You keep Zoho-related data in files.
2. You ask Snap to inspect, clean, compare, or act on those files.
3. Snap reads the relevant files and workflow docs.
4. Snap prepares a plan or output.
5. If Zoho action is needed, Snap uses your browser session.
6. Snap performs the action record by record.
7. Snap verifies the result.
8. Snap creates or updates reports and output files.

This is already close to the product you want to build.

The difference is that today the workflow is conversational and file-based. The future product should make it structured, repeatable, and available to 2 to 3 department users.

## 5. Current Zoho Work Types

Based on the workspace, your Zoho work currently includes:

- Contact upload preparation
- Account matching
- Deal creation tracking
- Deal link tracking
- Email scheduling
- Follow-up email drafts
- Task creation
- Task completion
- Duplicate checking
- Missing contact checks
- Account/contact coverage reports
- Owner assignment
- Campaign or batch tracking
- Zoho workflow documentation

These should become the foundation of the future system.

## 6. Current File-Based Workflow

Today, much of the workflow depends on files.

Common file types:

- `.csv`
- `.xlsx`
- `.md`
- `.docx`
- `.png`

Common file categories:

- Input files from exports or Apollo/contact sources
- Cleaned upload files for Zoho
- Deal status files
- Account link files
- Contact link files
- Email draft files
- Workflow instruction files
- Audit reports
- Final result CSVs

Current process:

1. A source file appears.
2. Snap reads it.
3. Snap identifies the intended Zoho workflow.
4. Snap cleans or transforms the file.
5. Snap may compare it against existing Zoho/account/contact/deal files.
6. Snap creates an output file.
7. User or Snap uses the output for Zoho action.
8. Snap logs or summarizes what happened.

Future product improvement:

The online database should replace scattered file state. Files can still be imported and exported, but the database should become the main source of truth.

## 7. Current Browser-Based Zoho Workflow

When Snap uses Zoho through the browser, the workflow usually looks like this:

1. Open the correct Zoho page.
2. Confirm the user is logged in.
3. Open the target record using a Zoho URL.
4. Confirm record identity.
5. Perform the needed action.
6. Verify the result.
7. Move to the next record.
8. Stop if there is a mismatch or missing data.

Example actions:

- Open a deal page
- Confirm the deal contact
- Compose an email
- Add subject and body
- Schedule the email
- Create a task
- Mark a task completed
- Update a deal field
- Verify the email/task/field update

This browser-based model is important because it avoids login/logout problems. It uses the user's own logged-in Zoho profile.

## 8. How You Should Use Snap Today For Zoho Work

The best way to use Snap is to give a clear task plus the relevant file or folder.

Good request examples:

- "Check this contact upload CSV for missing emails and duplicates."
- "Create a Zoho-ready contact upload file from this spreadsheet."
- "Compare this account list against the existing Zoho account links."
- "Schedule these emails in Zoho using the workflow file."
- "Create tasks for these deals and give me a result report."
- "Update the deal Next Step for this batch."
- "Find which contacts did not get scheduled emails."
- "Make a coverage report by account."

The more specific the request, the safer the result.

## 9. Information Snap Needs For Zoho Tasks

For most Zoho work, Snap needs:

- Target workflow
- Input file or record list
- Zoho record links or IDs
- Required fields
- Owner/user context
- Dates and times
- Email subject/body, if scheduling emails
- Rules for skipping records
- Rules for duplicates
- Expected final output

For email scheduling:

- Deal URL
- Contact name
- Contact email
- Subject
- Email body
- Schedule date
- Schedule time
- CC rules
- Signature rules
- Whether to update Next Step or stage
- Whether to create or close tasks

For task creation:

- Record URL
- Record type
- Task subject
- Due date
- Owner
- Notes
- Duplicate handling rule

For deal/account/contact updates:

- Record URL or ID
- Field to update
- Current expected value, if known
- New value
- Whether to skip if the current value differs

## 10. Snap's Ideal Zoho Work Pattern

The best pattern is:

1. Understand the task.
2. Identify the workflow.
3. Read the source files.
4. Validate required data.
5. Create a preview or plan.
6. Ask for confirmation if the action affects Zoho.
7. Execute in Zoho.
8. Verify each result.
9. Save a report.
10. Summarize completion.

This should become the default pattern for the future Zoho agent too.

## 11. What Snap Does Well

Snap is useful for:

- Understanding messy file structures
- Extracting data from spreadsheets and documents
- Reconciling contacts, accounts, and deals
- Following detailed workflows
- Creating repeatable playbooks
- Running batch checks
- Operating Zoho through a logged-in browser
- Producing reports
- Stopping when data does not match

This is why the current Snap workflow is a good prototype for the future Zoho agent.

## 12. What Snap Should Not Do Without Clear Approval

Snap should not silently:

- Send emails immediately
- Delete Zoho records
- Overwrite important fields in bulk
- Create duplicate contacts/accounts/deals
- Change ownership unexpectedly
- Continue if contact/account/deal identity does not match
- Guess missing email content
- Schedule emails when subject/body/date/time are incomplete

The same restrictions should exist in the future product.

## 13. How The Future Zoho Agent Should Copy Snap

The future agent should copy these parts of Snap:

- Use the user's logged-in browser session
- Follow written workflows
- Read structured input data
- Validate before acting
- Verify after acting
- Stop on mismatches
- Produce result reports
- Keep logs
- Work record by record

But it should improve on Snap in these ways:

- Use a web app instead of only chat
- Store data in an online database
- Make workflows selectable
- Make previews visual
- Make permissions clear
- Let multiple users run approved workflows
- Keep durable run history
- Reduce dependence on scattered CSVs

## 14. Snap-Inspired Future Architecture

The future system should have these equivalents:

| Current Snap Concept | Future Product Equivalent |
|---|---|
| Chat request | Web app workflow selection |
| Workspace files | Online database plus uploads |
| Markdown workflow docs | Structured workflow definitions |
| Browser control | Chrome extension / browser connector |
| Snap reasoning | Workflow router and validation engine |
| Manual final summary | Run report dashboard |
| Scratch scripts | Reusable execution steps |
| File output | Database log plus downloadable CSV |

## 15. Example Current Snap Workflow: Email Scheduling

Current Snap-style flow:

1. User asks Snap to schedule emails.
2. Snap reads the email draft file.
3. Snap reads the deal status or deal link file.
4. Snap matches contacts to deals.
5. Snap checks for missing subjects, bodies, or links.
6. Snap opens Zoho through the user's browser.
7. Snap opens each deal.
8. Snap confirms the contact/account match.
9. Snap opens the email composer.
10. Snap fills recipient, CC, subject, and body.
11. Snap schedules the email.
12. Snap verifies the scheduled email.
13. Snap updates task or Next Step if required.
14. Snap records success or failure.
15. Snap reports the final batch result.

Future product version:

1. User chooses "Schedule Zoho Emails" in the web app.
2. User uploads/selects the batch.
3. App validates all rows.
4. App shows preview.
5. User approves.
6. Extension performs the same Zoho steps.
7. App shows live progress.
8. App stores final report.

## 16. Example Current Snap Workflow: Task Creation

Current Snap-style flow:

1. User provides a CSV or list of deals.
2. Snap checks each row for a valid deal link.
3. Snap opens the Zoho deal.
4. Snap verifies the deal.
5. Snap creates the task with the correct subject and due date.
6. Snap verifies the task appears.
7. Snap logs the result.

Future product version:

1. User chooses "Create Tasks".
2. User uploads/selects target records.
3. User enters task subject, due date, owner, and notes.
4. App previews tasks.
5. User approves.
6. Extension creates tasks.
7. App records success and failures.

## 17. Example Current Snap Workflow: Deal Field Update

Current Snap-style flow:

1. User provides a list of deals and desired field updates.
2. Snap checks deal links.
3. Snap opens each deal.
4. Snap reads the current value.
5. Snap updates the field.
6. Snap saves.
7. Snap verifies the new value.
8. Snap records before and after values.

Future product version:

1. User chooses "Update Deal Fields".
2. User maps CSV columns to Zoho fields.
3. App shows before/after preview if current values are available.
4. User approves.
5. Extension updates each deal.
6. App logs before and after values.

## 18. How A User Should Talk To The Future Agent

The future agent should not require vague chat prompts.

Better user flow:

1. Choose workflow.
2. Choose records.
3. Fill required fields.
4. Review preview.
5. Approve run.

The agent can still have a chat interface, but chat should not be the only control surface.

Good future commands:

- "Run email scheduling for KD Blitz Batch 5."
- "Create 1st Email tasks for these 30 deals."
- "Update Next Step to 2nd Email for this batch."
- "Create deals for these accounts if no duplicate deal exists."
- "Show me records that failed last run."

Bad future commands:

- "Clean up Zoho."
- "Do the campaign."
- "Fix these records."
- "Handle the follow-ups."

The system should turn vague commands into a request for clarification, not silent action.

## 19. Snap's Stop Conditions For Zoho Work

Snap should stop or ask before continuing when:

- The Zoho page opens the wrong record
- Contact name does not match
- Account name does not match
- Deal link is missing
- Contact email is missing
- Email subject is missing
- Email body is missing
- A duplicate scheduled email already exists
- A duplicate task already exists and no rule is provided
- More than one matching record is found
- Zoho shows an error
- User is logged out
- Required field is not editable

These stop conditions should become formal product rules.

## 20. Verification Checklist By Task Type

### Email Scheduling

Verify:

- Email appears as scheduled
- Recipient is correct
- CC is correct
- Subject is correct
- Date and time are correct
- Related deal/contact is correct
- Any required task or field update is complete

### Task Creation

Verify:

- Task appears in Open Activities
- Subject is correct
- Due date is correct
- Related record is correct
- Owner is correct if used

### Task Completion

Verify:

- Task is no longer open
- Task appears as completed if Zoho shows closed activities
- Correct task was completed

### Deal Update

Verify:

- Deal URL is correct
- Field after save equals requested value
- Before and after values are logged

### Account Or Contact Creation

Verify:

- Record exists
- Zoho link is captured
- Required fields are correct
- Duplicate was not created
- Contact is linked to correct account

## 21. How Snap Reports Work Back To You

A good Snap final report should include:

- What was completed
- Which file was created or updated
- How many records succeeded
- How many were skipped
- How many failed
- Why failures happened
- Link to the final artifact or report

For Zoho actions, a good report should also include:

- Zoho links
- Record names
- Action taken
- Verification status
- Next manual steps, if any

## 22. How This Should Become Product Logic

The future system should convert Snap's behavior into product logic.

Current Snap behavior:

- Reads user message
- Finds relevant files
- Uses workflow knowledge
- Acts in browser
- Verifies
- Reports

Future system behavior:

- User selects workflow
- Database provides records
- Workflow definition provides rules
- Extension acts in Zoho
- Verification engine checks result
- Run log stores report

This makes the process repeatable for the whole department.

## 23. Recommended Workflow Template

Every workflow should be documented like this:

```markdown
# Workflow Name

## Purpose

What this workflow does.

## Inputs

Required and optional inputs.

## Preconditions

What must be true before running.

## Validation Rules

Checks before action.

## Execution Steps

Exact steps to perform.

## Verification Steps

How to confirm success.

## Stop Conditions

When to stop and ask the user.

## Output

What report or data should be saved.
```

## 24. Practical Usage Rules For You

When asking Snap to do Zoho work today, use this structure:

```text
Goal:
What you want done.

Input:
Which file, batch, or records to use.

Workflow:
Which Zoho workflow to follow.

Rules:
Dates, owners, CCs, duplicate handling, skip conditions.

Output:
What report or file you want back.
```

Example:

```text
Goal:
Schedule the KD Blitz Batch 5 emails in Zoho.

Input:
Use KD Blitz Batch 5 All Contacts Email Drafts.md and the batch 5 deal links file.

Workflow:
Use the KD Blitz email scheduling playbook.

Rules:
Schedule only. Do not send immediately. Use the first subject. Stop on contact mismatch.

Output:
Give me a CSV report with success, skipped, failed, and Zoho links.
```

## 25. Why This Matters For The New Agent

The new agent should be designed around the real way Snap is already useful:

- It understands your Zoho workflow context
- It uses your files and links
- It follows rules
- It acts in the browser
- It verifies
- It reports

The product should not try to make the agent overly free-form. The winning design is a controlled workflow runner that uses an agent only where judgment and page handling are needed.

## 26. Final Principle

Snap is the prototype.

The future Zoho agent should take what works about Snap and turn it into a safer, repeatable, team-friendly system:

- Less scattered file state
- More database-backed records
- Less vague chat control
- More workflow selection
- Less manual checking
- More automatic verification
- Less hidden action
- More audit logs

The goal is not to replace judgment. The goal is to remove repetitive Zoho operations while keeping the user in control.

