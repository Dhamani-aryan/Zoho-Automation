# Sample Workflow

This example describes the intended shape of a CRM automation run without using private customer data.

## User request

> Update the next step for the Example Manufacturing deal, create a follow-up task, and schedule the prepared email for Thursday at 10 AM.

## Agent flow

1. Resolve the deal and related contact from the record mirror.
2. Read the live CRM record to confirm current state.
3. Parse the requested actions into structured blocks.
4. Validate the field name, value, task subject, due date, email recipient, subject, body, and schedule time.
5. Show a preview with eligible, skipped, and needs-review rows.
6. Wait for approval.
7. Execute the approved CRM changes through the logged-in browser session.
8. Read back the updated field, task state, and scheduled email state.
9. Write a run report with links, counts, and failures.

## Why this matters

The agent is useful because it handles the repetitive work while preserving accountability. A user can see what will happen, approve it, stop it, and inspect what actually happened afterward.
