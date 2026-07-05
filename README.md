# Zoho Automation

Private internal repo for the KloudData Zoho Workflow Agent.

The project is a controlled workflow executor for repetitive Zoho CRM operations. Users type a plain-English command, attach any needed files, review a deterministic preview, approve the run, and later the system executes verified actions inside each user's own logged-in Zoho session.

## Current Status

- Phase 1 foundation is complete: Next.js app, Supabase Auth, role guards, RLS, imports, record browser, and operational dashboard.
- Phase 2 command planning is complete: per-user encrypted OpenAI/ChatGPT credentials, command parsing, deterministic validation, and preview run creation.
- Phase 3 is next: Chrome extension plus the first live Zoho executor block, starting with `update_deal_field` for Deal `Next_Step`.

Phase 2 does not call Zoho and does not write CRM data. Live Zoho execution begins in Phase 3.

## Repository Layout

- `zoho-agent/` - Next.js app, API routes, Supabase schema, LLM provider layer, validation engine, and app README.
- `zoho-agent/docs/` - engineering decision logs for Phase 1 and Phase 2.
- `zoho-agent/supabase/` - Supabase schema and Phase 2 migration SQL.
- `workflows/` - workflow specs for record editing, KD Blitz, parser/preview, and LLM credentials.
- `reference/` - Zoho session API reference.
- `source_docs/` - original workflow/source playbooks.
- `PROJECT_OVERVIEW.md` - plain-English project overview.
- `ZOHO_AGENT_WORK_PLAN.md` - master plan and build guide.
- `HANDOFF.md` - handoff summary for future coding sessions.

## Local App Setup

```powershell
cd zoho-agent
npm install
copy .env.example .env.local
npm run dev
```

Fill `.env.local` with Supabase credentials and `LLM_CRED_ENC_KEY` before testing Phase 2 credential storage. See `zoho-agent/README.md` for the detailed setup steps.

## Safety Model

- Preview and approval before any write.
- No deletes in v1.
- No immediate email sends; email workflows schedule only.
- Zoho passwords are not stored.
- LLM output is only a structured plan; deterministic code validates before anything is considered runnable.
- Audit logs record who did what and why rows were eligible, skipped, or marked for review.

## Key Docs

Start here:

1. `PROJECT_OVERVIEW.md`
2. `ZOHO_AGENT_WORK_PLAN.md`
3. `zoho-agent/README.md`
4. `zoho-agent/docs/PHASE_2_DECISIONS.md`
