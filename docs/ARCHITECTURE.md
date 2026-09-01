# Architecture

Zoho Workflow Agent is split into five parts:

1. A Next.js app for login, records, previews, runs, settings, and agent chat.
2. Supabase for auth, row-level security, record mirror tables, workflow state, and audit data.
3. A planning layer that asks an LLM to convert plain English into strict JSON.
4. A deterministic validation layer that checks the plan before any execution.
5. A Chrome extension bridge that performs live CRM actions through the user's own browser session.

## Planning boundary

The LLM is not allowed to execute. It only proposes a structured plan. Application code validates records, fields, picklists, dates, and required inputs before a run can continue.

## Execution boundary

The extension runs inside a logged-in CRM browser tab. API-shaped work uses the CRM session API when possible. UI-only work, such as composer and scheduler flows, uses browser observation and targeted UI actions.

## Verification boundary

Every state-changing action must be read back from the CRM before it is reported as successful. If a write returns OK but the read-back does not match, the run records the mismatch instead of pretending it worked.

## Safety defaults

- No delete flows.
- No send-now email flows.
- Approval before write-oriented runs.
- Duplicate checks before creating tasks or scheduling repeat work.
- Per-user credentials encrypted at rest.
- Role checks before admin-sensitive actions.
