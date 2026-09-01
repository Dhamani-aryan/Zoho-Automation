# Zoho Workflow Agent

Zoho Workflow Agent is an AI operations agent for repetitive CRM work. It turns plain-English requests into validated previews, then executes approved actions through the user's own logged-in Zoho session.

The project is built around one principle: agents should do the work, but humans should stay in control. Every meaningful change is parsed, checked, previewed, executed with guardrails, verified after the fact, and written to an audit trail.

## Why I built this

CRM operations often become repetitive browser work: updating fields, creating tasks, changing owners, tagging records, preparing outreach, and checking whether the change actually landed. A normal script is too brittle, and a free-form AI agent is too risky.

This project explores the middle path:

- AI translates the user's request into a structured plan.
- Deterministic validation checks records, fields, picklists, dates, and eligibility.
- A preview shows exactly what will change before execution.
- A Chrome extension runs approved work inside the user's existing Zoho session.
- Live read-backs verify the final state instead of trusting the click or API response.

## Core capabilities

- Natural-language command parsing for CRM workflows.
- Supabase-backed record mirror for fast search and filtering.
- Role-based access for admins, operators, and reviewers.
- Per-user LLM credentials encrypted at rest.
- Preview-first workflow planning with skip and needs-review states.
- Chrome extension bridge for live Zoho reads, writes, and UI-only workflows.
- Approval-aware execution model for CRM changes.
- Post-action verification and reporting.
- Audit-friendly run history.

## Agent workflow

```text
User request
  -> AI command parser
  -> Deterministic validator
  -> Human-readable preview
  -> Approval gate
  -> Zoho session executor
  -> Live verification
  -> Run report
```

The agent never treats model output as authority. The model proposes structure. The application validates and executes.

## Architecture

```text
Next.js app
  -> Supabase Auth, Postgres, and RLS
  -> LLM provider layer
  -> Validation and preview engine
  -> Agent runtime
  -> Chrome extension job bridge
  -> Zoho CRM live session
```

The extension uses the user's browser session instead of storing Zoho passwords. This keeps account permissions tied to the person who is actually logged in.

## Tech stack

- Next.js
- TypeScript
- Supabase
- PostgreSQL with row-level security
- Chrome extension APIs
- OpenAI-compatible LLM provider layer
- Zod validation
- Vitest and TypeScript test configs

## Safety model

- No deletes in the first version.
- No immediate email sends.
- Preview and approval before CRM-changing runs.
- Live read-back after each write.
- Duplicate checks before creating tasks or scheduled work.
- Encrypted user-level LLM credentials.
- Role guards for sensitive actions.
- Structured run reports for successes, skips, and failures.

## Local setup

```sh
cd zoho-agent
npm install
copy .env.example .env.local
npm run dev
```

Fill `.env.local` with Supabase values and an encryption key before testing credential storage.

## Public docs

- [Architecture](docs/ARCHITECTURE.md)
- [Sample workflow](docs/SAMPLE_WORKFLOW.md)

## Project status

The app foundation, authentication, record mirror, command parser, validation flow, preview runs, agent chat surface, and extension bridge are in place. The next focus is production-hardening live execution flows and adding more reusable workflow guides.

## What this shows

This repo is a serious example of agentic automation for real business software: browser control, structured planning, approval gates, deterministic validation, and verification-driven execution.
