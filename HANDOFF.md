# PROJECT HANDOFF — Zoho Workflow Agent

*Paste this into a new chat to bring it fully up to speed. Reusable — update the Status section as the project moves.*

Owner: Aryan Dhamani (aryan@klouddata.com), KloudData.
All project files live in `G:\Zoho Automation` (a connected/mounted folder).

## Read these first, in order
- `workflows/SPEC_v2_tool_agent_migration.md` — the CURRENT roadmap (v2 tool-calling agent) + per-phase specs it indexes in §10
- `zoho-agent/docs/V2_DECISIONS.md` — live decision/review log (newest entries at top); binding engineering invariants
- `ZOHO_AGENT_WORK_PLAN.md` — original build guide; §2 locked decisions + §3 environment facts still bind
- `reference/ZOHO_SESSION_API_REFERENCE.md` — Zoho session-API mechanics
- Older context when needed: `PROJECT_OVERVIEW.md`, `zoho-agent/docs/PHASE_1/2/3_DECISIONS.md`, remaining `workflows/` specs

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

## Immediate next steps (updated 2026-07-09)
**PIVOT (2026-07-05):** primary UX is now a tool-calling chat agent (`/agent`): Tier-0 DB tools, Tier-1 live Zoho reads via the Chrome extension job bridge + mirror sync, Tier-2 approval-gated Zoho writes. Batch run pipeline retained for presets. CRM writes keep the human approval gate - always.

State: **Phases A, B, C, and D are built, chat-reviewed, and live-accepted. Phase E hardening is in build.** Phase E is hardening only: review backlog burn-down, sweeps/retention, env budgets, `/admin/agent-activity`, `/agent` landing, extension job history, one-page guide, and `zoho-agent/docs/V2_TEST_CHECKLIST.md`. No new agent tool surface. Purge is admin-only, confirmed, and never automatic.
1. Finish Phase E verification: typecheck, lint, build, build:extension, orchestrator/records/tier2 tests, then complete every item in `zoho-agent/docs/V2_TEST_CHECKLIST.md`.
2. Stop for chat review before declaring Phase E done.
3. Phase F remains next: UI navigation and teachable workflows.

Chat's role: write/maintain specs, review every Codex phase for defects/races/slop (verify independently — `git show` + typecheck from the sandbox via /tmp copies; the mount's view of fresh writes lags), fix small defects directly, keep V2_DECISIONS + this file current. Sandbox CANNOT run git writes or Windows-installed binaries (esbuild/SWC) — builds and commits happen in Aryan's PowerShell; always end reviews with the exact `git add/commit` commands.

Confirm you've read the files above before proceeding.
