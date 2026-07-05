# PROJECT HANDOFF — Zoho Workflow Agent

*Paste this into a new chat to bring it fully up to speed. Reusable — update the Status section as the project moves.*

Owner: Aryan Dhamani (aryan@klouddata.com), KloudData.
All project files live in `G:\Zoho Automation` (a connected/mounted folder).

## Read these first, in order
- `G:\Zoho Automation\ZOHO_AGENT_WORK_PLAN.md` — master build guide + live status
- `G:\Zoho Automation\PROJECT_OVERVIEW.md` — plain-English overview
- `G:\Zoho Automation\zoho-agent\docs\PHASE_2_DECISIONS.md` and `PHASE_1_DECISIONS.md` — engineering decision logs
- `G:\Zoho Automation\workflows\` (5 specs — Phase 3 spec: `SPEC_phase3_extension_live_execution.md`) and `G:\Zoho Automation\reference\ZOHO_SESSION_API_REFERENCE.md`

## What it is
An internal web app for a 2–4 person sales-ops team to run repetitive Zoho CRM work (schedule outreach emails, create/complete tasks, update deal/account/contact fields, change owners, add tags) by typing a plain-English command → seeing a validated preview → approving → the tool executes inside each user's own logged-in Zoho session, verifies, and reports. Human-in-control: preview + approval always; no deletes; emails scheduled not sent; no Zoho passwords stored.

## Architecture / stack
Next.js app + API on Vercel; Supabase (Postgres + Auth + Storage, row-level security); a pluggable AI layer that ONLY turns command+files into a structured plan (deterministic code then validates it — the LLM never touches Zoho); and a planned Chrome extension that executes approved plans via Zoho's session API (CSRF-token, same-origin) for data changes and the Zoho UI for email/tasks. Zoho org is `890324941` on crm.zoho.com. Code is in `G:\Zoho Automation\zoho-agent`.

## Key design
Work = small toggleable "action blocks" (create_task, complete_task, update_deal_field, update_account/contact_fields, change_owner, add/remove_tags, schedule_email); "presets" chain them (e.g. "KD Blitz"). Per-user LLM credentials, AES-256-GCM encrypted in table `user_llm_credentials`; each user connects via one of three methods: ChatGPT device-code, paste `~/.codex/auth.json` credential, or OpenAI API key.

## Status (2026-07-04): Phases 0, 1, 2 COMPLETE
- **Phase 1:** app + hardened auth (@supabase/ssr + middleware + role guards) + DB live; full book of business loaded & cross-linked (315 accounts, 833 contacts, 179 deals) plus all Zoho field metadata (via `npm run import:masters` / `import:fieldmeta`; cleaning script `imports\clean_exports.py`).
- **Phase 2:** command → parse (`/api/plan/parse`) → validate (`/api/plan/validate`) → preview → approved run (`/api/runs`) pipeline. Per-block validation with tag selection, picklist/email/opt-out/future-date checks, name-match fallback. Reviewed and fixed; `npm run typecheck` passes, `npm run build` passes on Aryan's machine. **Phase 2 makes ZERO Zoho calls by design.**

## Working method
Codex (the coding agent) writes the code locally; the chat writes specs, reviews Codex's output for quality/"slop," fixes issues, and keeps docs updated. Git commits must be authored as Aryan Dhamani (his personal email `dhamaniaryan4@gmail.com` is the one in use — confirmed 2026-07-05) with NO AI co-author. Note: the repo's `.git` is on a Windows drive, so git often must be run in Aryan's PowerShell, not the agent sandbox.

## Immediate next steps
**PIVOT (2026-07-05):** Aryan decided to migrate the primary UX to a tool-calling agent (chat; tools for DB search, live Zoho reads through the extension, DB sync, approval-gated writes). The complete migration plan for Codex is `workflows/SPEC_v2_tool_agent_migration.md` — read it before anything else; work proceeds in its Phases A–E, logged to `zoho-agent/docs/V2_DECISIONS.md`. The batch run pipeline and the Phase 3 extension work (steps 1–5, built + reviewed) are retained and reused. CRM writes keep the human approval gate.

Confirm you've read the files above before proceeding.
