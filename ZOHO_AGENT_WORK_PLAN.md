# Zoho Workflow Agent — Master Plan & Build Guide

Version 2.1 — 2026-07-04
Owner: Aryan Dhamani (aryan@klouddata.com), KloudData
Status: **Phases 0, 1, 2 COMPLETE (2026-07-04).**

- **Phase 1:** App running locally, hardened auth (@supabase/ssr + middleware + role guards); Supabase live with full schema/RLS/seeds. Data loaded via `npm run import:masters`: **315 accounts, 833 contacts (all account-linked), 179 deals (all account-linked, 161 contact-linked)**; cleaning via `imports\clean_exports.py`. Field metadata synced (`npm run import:fieldmeta`): Accounts 64, Contacts 73, Deals 29, Tasks 19 incl. picklists.
- **Phase 2:** Per-user LLM credentials — each user connects via any of three methods (ChatGPT device-code flow, paste `~/.codex/auth.json` credential, or OpenAI API key), AES-256-GCM encrypted, table `user_llm_credentials`. Command → parse (`/api/plan/parse`) → validate (`/api/plan/validate`) → preview → approved run (`/api/runs`) pipeline. Per-block validation with tag selection, picklist/email/opt-out/future-date checks, name-match fallback. Reviewed, fixed, `npm run build` passes. **No Zoho calls / no CRM writes yet, by design.** See `docs/PHASE_2_DECISIONS.md` + `workflows/SPEC_phase2_parser_validation_preview.md`.

Vercel deploy deferred until team onboarding. **Phase 2 manual testing in progress (2026-07-05): credential connect + first parse/validate confirmed working on real data after a day of fixes — see `zoho-agent/docs/PHASE_2_DECISIONS.md`. Next: finish the ~10 Phase 2 acceptance tests, then Phase 3 — Chrome extension + live Zoho execution (first block: `update_deal_field` / Next Step). The Phase 3 build spec is written: `workflows/SPEC_phase3_extension_live_execution.md`.**

This document is self-contained: a new chat or developer can execute the project from this file alone. Companion files (same folder) hold deeper detail and are referenced where relevant.

```
Zoho Automation\
├── ZOHO_AGENT_WORK_PLAN.md                      ← this file
├── source_docs\                                  ← Aryan's original playbooks (6 files, proven in production)
├── workflows\SPEC_kd_blitz_email_scheduling.md   ← email scheduling + task + Next Step spec
├── workflows\SPEC_record_editing.md              ← field/owner/tag editing spec
├── workflows\SPEC_phase3_extension_live_execution.md ← Phase 3 build spec (extension + live API blocks)
└── reference\ZOHO_SESSION_API_REFERENCE.md       ← Zoho session-API auth, endpoints, field names, gotchas
```

---

## 1. Vision

One shareable agent for a small sales-ops team (2–3 users) that executes repetitive Zoho CRM work safely.

> A user opens the web app and gives a specific command — "Schedule these email drafts to these contacts at 8 PM Monday", "Change deal owner to Linda for this batch", "Update Next Step on these 30 deals" — attaching files or selecting saved records. The agent interprets the command, pulls links/drafts/rules from the central database, and shows a preview of exactly what will happen. The user selects which action blocks to include, approves, and the system executes in that user's own logged-in Zoho browser session, record by record, verifying every action. Output: a full report — success / skipped / failed, Zoho links, reasons.

This is a **controlled workflow executor with an AI front door**, not a free-form chat agent. The LLM never improvises in the browser; it only translates commands into structured plans that deterministic code validates and executes.

## 2. Locked Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Execution | In the user's logged-in browser session, two modes: **(a) Zoho session API** (primary — search, reads, edits, owners, tags, duplicate checks, verification) and **(b) UI automation** (only for UI-only actions: email compose/schedule, task UI). No OAuth, no stored passwords. |
| 2 | Browser bridge | Custom Chrome extension (Manifest V3), installed unpacked on each user's machine, host permissions locked to Zoho CRM domains, executes only steps of an approved run belonging to the same logged-in user. |
| 3 | Agent brain | Hybrid. Our own agent layer; LLM behind a swappable `LLMProvider` interface. **Per-user credentials (not global): each user connects their OWN OpenAI access in Settings — either their ChatGPT subscription (Codex device-code flow, endorsed by OpenAI as "Codex for OSS") OR their own API key. Secrets stored encrypted per-user; resolved per request from the triggering user.** See `workflows/SPEC_llm_provider_codex_subscription.md`. LLM's only job: command + files → structured plan JSON. |
| 4 | Command input | Free-text command box + file attach → structured preview requiring explicit approval. Saved presets for recurring runs. |
| 5 | Hosting | Supabase (Postgres + Auth + Storage) + Vercel (Next.js web app + API). |
| 6 | Workflow structure | **Atomic action blocks**, user-toggleable per run. Composites (e.g. "KD Blitz") are saved presets chaining blocks. Block values (task subject, Next Step value, CC, times) are inputs, never hardcoded. |
| 7 | Scope v1 | Zoho CRM only (org `890324941`, crm.zoho.com). No deletes, no immediate email sends, no LinkedIn/Gmail/other CRMs, no autonomous decisions without approval. |

## 3. Environment Facts (from production playbooks)

- Org ID: `890324941` — in URLs as `org890324941`, sent as `X-CRM-ORG` header on API calls.
- Record URLs: `https://crm.zoho.com/crm/org890324941/tab/{Potentials|Contacts|Accounts}/{id}` (deals module is called `Potentials` in URLs but **`Deals`** in the API).
- API bases: read/search `https://crm.zoho.com/crm/v3/...`, write `https://crm.zoho.com/crm/v2.2/...`.
- Auth: hidden `#token` input on every CRM page → header `X-ZCSRF-TOKEN: crmcsrfparam=<token>`, plus `X-CRM-ORG` and `X-Requested-With: XMLHttpRequest`; fetch with `credentials:'include'` from inside the CRM tab.
- Writes: `PUT /crm/v2.2/{Module}` with `{data:[{id, ...fields}]}`, **max 100/call**, idempotent, per-record `code === 'SUCCESS'`.
- Tags via `actions/add_tags` / `remove_tags`, not field PUT.
- Search: 204 = no match; special characters break criteria (fallback: `starts_with` prefix + client-side filter); paginate via `info.more_records`; multiple matches = needs_review, never auto-pick.
- Owner change via API: no notification email, no cascade to related records.
- Field metadata (incl. custom fields, picklists): `GET /crm/v3/settings/fields?module={Module}` — sync into DB for validation.
- Known user ID: Linda Spione = `6834250000003103001`. Sender identity: Aryan Dhamani `<aryan@klouddata.com>`.
- Deal naming convention: `"{Account} | SAP Cloud ERP"`.
- Full endpoint/selector detail: `reference/ZOHO_SESSION_API_REFERENCE.md` and `source_docs/`.

## 4. Architecture

```
User's machine                                     Cloud
┌─────────────────────────────────────┐           ┌──────────────────────────────────┐
│ Web app tab (Vercel)                │   HTTPS   │ Backend (Next.js API on Vercel)  │
│  command box · preview · approve    │◄─────────►│  auth/roles · command parser     │
│  live progress · reports · admin    │           │  (LLM) · validation engine ·     │
│                                     │           │  run orchestrator · reports      │
│ Chrome extension (MV3)              │           │                                  │
│  Zoho domains only                  │◄─────────►│ Supabase Postgres + Storage      │
│  session-API steps + UI steps       │           │  records · workflows · runs ·    │
│  executes approved runs only        │           │  audit · files                   │
│      │                              │           └──────────────────────────────────┘
│      ▼                              │
│ Zoho CRM tab (user's own login)     │
└─────────────────────────────────────┘
```

**Command parser (LLM):** input = user command + attached file contents + catalog of action blocks/presets. Output = strict JSON: `{blocks:[{slug, config}], records[], run_parameters, warnings, missing_info[]}`. If info is missing or the command is vague ("clean up Zoho"), it returns questions — never a runnable plan. Zero browser access, zero write access.

**Validation engine (deterministic):** applies each block's rules to every record: required fields, email format, date validity, URL patterns, picklist membership (from synced field metadata), duplicate checks against DB run history (and live Zoho via extension search when needed).

**Run orchestrator:** creates `workflow_runs` + `workflow_run_items`, serves steps to the extension one item at a time, tracks statuses (`pending / running / success / skipped / failed / needs_review`), enforces stop thresholds, finalizes reports.

**Chrome extension:** polls/receives steps for approved runs of its logged-in user. Step vocabulary is fixed:
- API steps: `api_search`, `api_read`, `api_update`, `api_tag`, `api_verify`
- UI steps: `open_url`, `confirm_text_present`, `read_field`, `fill_field`, `click`, `wait_for`, `verify_field`, `screenshot_on_error`
Detects logged-out state; attaches page evidence to failures; selectors live in one config file (see KD Blitz spec §9 for the current map).

## 5. Action Block Catalog

Every block defines: inputs, validations, execution, verification, stop conditions. All are user-toggleable in run setup; any subset can form a run; presets save common chains.

| Block | Module(s) | Mode | Summary |
|---|---|---|---|
| `create_task` | deal/account/contact | UI | Subject, due date, owner, notes; duplicate check; verify in Open Activities |
| `complete_task` | same | UI | Match open task by subject (+date); mark complete; verify gone from Open Activities; retry once on render lag |
| `update_deal_field` | deals | API | e.g. Next_Step, Stage, Owner, Closing_Date; before/after logged |
| `update_contact_fields` | contacts | API | Phone/Mobile/Email/Title/etc.; file Phone→Phone, Mobile→Mobile; skip only if no data at all |
| `update_account_fields` | accounts | API | Website/Industry/addresses/etc. |
| `change_owner` | all three | API | Name → user ID resolution; no email/cascade (explicit options) |
| `add_tags` / `remove_tags` | all three | API | Tag actions endpoint; verify Tag[] |
| `schedule_email` | deal/contact | UI | Compose in user's session: recipient, CC, subject (option 1), body above signature (Verdana 13.33px, no leading blank, 2 blank lines before signature), schedule never send; duplicate check; verify toast + Scheduled tab |
| `resolve_records` | helper | API | Names → IDs with proven fallbacks; children enumeration; title/persona filtering; ambiguity → needs_review |

**Preset examples:** "KD Blitz" = create_task("1st Email") → complete_task → update_deal_field(Next_Step="2nd Email") → schedule_email (per contact). "Assign book of business" = change_owner on Accounts → Contacts → Deals with per-module verification.

Run parameters that historically change between batches (CC list, schedule date/time, task due date) are **always confirmed in preview, never assumed**. Schedule date is checked against the live CRM clock. Full block detail: the two SPEC files.

## 6. Run Pipeline (every run)

1. **Command** — user types instruction; attaches CSV/MD or picks saved records/preset.
2. **Parse** — LLM → structured plan JSON, or clarifying questions.
3. **Resolve** — enrich from DB; live name→ID resolution via extension search if needed.
4. **Validate** — deterministic rules per block per record.
5. **Preview** — per-record table: blocks to run, targets, values, warnings, skips; run parameters displayed for confirmation; block toggles editable here.
6. **Approve** — explicit click. Dry-run available (validates + previews, touches nothing).
7. **Execute** — extension processes items sequentially; identity check before each action (record name matches expected).
8. **Verify** — read-back after every write (API) or page evidence (UI: chip read-back, success toast, screenshots).
9. **Report** — web report + CSV download + DB log: totals, per-record status, Zoho links, before/after, failure reasons.

**Hard stop conditions:** wrong record opened; contact/account/deal name mismatch; missing link/email/subject/body; duplicate scheduled email or task; ambiguous multi-match; Zoho error or logged-out; field not editable; 3 consecutive failures or >20% failure rate. On stop: run pauses, user decides. Interrupted runs are resumable (items are idempotent or skipped-if-done).

**Never in v1:** delete records; send email immediately; change deal Stage during KD Blitz flows; create records as a side effect (stop and ask); act outside Zoho domains; run without preview + approval.

## 7. Database Schema (Supabase Postgres)

| Table | Key columns |
|---|---|
| `users` | id, name, email, role (admin/operator/reviewer), status |
| `accounts` | id, zoho_account_id, zoho_url, account_name, website, owner, source, raw_data jsonb, timestamps |
| `contacts` | id, zoho_contact_id, zoho_url, account_id FK, first/last/full_name, email, title, phone, mobile, owner, raw_data, timestamps |
| `deals` | id, zoho_deal_id, zoho_url, account_id FK, primary_contact_id FK, deal_name, stage, next_step, owner, closing_date, amount, raw_data, timestamps |
| `tasks` | id, zoho_task_id, related_record_type+id, subject, due_date, status, owner |
| `scheduled_emails` | id, related_deal_id, related_contact_id, to_email, cc_emails, subject, body, schedule_date, schedule_time, status, zoho_url |
| `zoho_field_meta` | module, api_name, label, data_type, picklist_values jsonb, synced_at |
| `action_blocks` | slug, name, module, mode (api/ui), required_inputs jsonb, validations jsonb, execution_steps jsonb, verification jsonb, stop_conditions jsonb, version, status |
| `presets` | name, slug, block_chain jsonb (ordered slugs + default configs), created_by |
| `workflow_runs` | id, preset/blocks jsonb, triggered_by, status, input_file ref, totals (success/skipped/failed), started/completed_at |
| `workflow_run_items` | run_id, row_number, record_type+key, block_slug, status, action, zoho_url, before_data, after_data, error_message, evidence ref |
| `audit_events` | user_id, run_id, event_type, message, metadata, created_at |
| `files` | Storage refs: uploaded CSVs, MD drafts, screenshots, reports |

Row Level Security: operators see own runs; admin sees all; reviewer read-only.

## 8. Build Phases — Concrete Steps

### Phase 1 — Foundation (database + web app skeleton)
1. Create Supabase project; run schema SQL (Section 7); enable RLS with role policies.
2. Scaffold Next.js (App Router, TypeScript) repo; deploy to Vercel; connect Supabase (env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`).
3. Auth: Supabase email/password login; seed the 2–3 users with roles.
4. Screens: login, dashboard (recent runs), records browser (accounts/contacts/deals tables with search), file upload (CSV/MD → Storage + parse preview).
5. Import Aryan's existing link CSVs (accounts/contacts/deals with Zoho URLs) into the DB via an admin import screen: upload → column map → validate → insert; store source file ref.
6. Field-meta sync: admin button that (via extension, or manual JSON paste in Phase 1) loads `/settings/fields` output per module into `zoho_field_meta`.
**Done when:** users log in; real records browsable; CSV import works.

### Phase 2 — Command parser + validation + preview
1. Define the plan JSON schema (blocks, records, run_parameters, missing_info).
2. `LLMProvider` interface; OpenAI implementation; system prompt = block catalog + parsing rules + "ask, don't guess".
3. Parser endpoint: command + parsed file contents → plan JSON; log prompt/response for audit.
4. Validation engine: rule functions per block, driven by `action_blocks` definitions + `zoho_field_meta`.
5. Preview UI: per-record table, block toggles, run-parameter confirmation panel, warnings/skips; dry-run mode.
6. Seed `action_blocks` + "KD Blitz" and "Assign book of business" presets from the SPEC files.
**Done when:** 10 varied real commands produce correct validated previews; vague commands produce questions.

### Phase 3 — Extension + first executor (session-API blocks)
1. Build MV3 extension: Zoho-domain content script, backend auth (user token), step executor loop, logged-out detection.
2. Implement API steps (`api_search/read/update/tag/verify`) with chunking ≤100, retries, per-record results.
3. Run orchestrator in backend: item queue, status tracking, stop thresholds, resumability.
4. Ship first live block: `update_deal_field` (e.g. Next Step batch) end to end with before/after verification and CSV report.
5. Then `change_owner`, `update_contact_fields`, `update_account_fields`, tags, and the book-of-business preset.
**Done when:** a 20+ record field-update run completes with verified before/after and accurate report. (API blocks first — they're the most reliable; UI blocks come next.)

### Phase 4 — UI executor blocks (tasks + email scheduling)
1. Implement UI steps in the extension; selector config from KD Blitz spec §9; screenshot-on-failure.
2. `create_task` + `complete_task` blocks (with the known render-lag retry).
3. MD drafts parser (contact sections → recipient/subject options/body/deal URL/date/time).
4. `schedule_email` block: compose, body insertion above signature with exact spacing/font rules, CC chips, schedule popup (zero-padded time labels, date picker), pre-schedule verification (chip read-back + screenshot), post-schedule verification (toast + Scheduled tab).
5. KD Blitz preset live end to end on a small real batch.
**Done when:** a full KD Blitz batch runs from command to verified report.

### Phase 5 — Team readiness
1. Onboard users 2–3: accounts, roles, extension installs on their machines.
2. Admin screens: audit log viewer, error dashboard, block/preset editor (admin-only), user management.
3. Run-history search; saved batches; report archive.
4. Short user guide (one page: how to run, how to read previews, what stops mean).
**Done when:** an operator other than Aryan completes a run unassisted.

## 9. Suggested Repo Structure

```
zoho-agent/
├── apps/web/            Next.js app (UI + API routes)
│   ├── app/             pages: login, dashboard, records, run/new, run/[id], admin/*
│   ├── lib/llm/         LLMProvider interface + openai.ts (+ anthropic.ts later)
│   ├── lib/validation/  per-block rule functions
│   ├── lib/orchestrator/ run state machine, step queue
│   └── lib/parsers/     csv.ts, drafts-md.ts
├── extension/           MV3: manifest.json, content script, step executors (api.ts, ui.ts), selectors.config.ts
├── supabase/            schema.sql, rls.sql, seed (blocks + presets)
└── docs/                copies of the SPEC + reference files
```

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Zoho UI changes | API-first execution (immune to UI); UI selectors centralized in one config; verification after every step |
| Duplicate actions | DB run history + duplicate checks before create/schedule; idempotent API writes |
| Bad input data | Validation + preview + row warnings; nothing unvalidated runs |
| Vague commands | Parser returns questions; unknown block = no plan |
| Mid-run interruption | Item-level state in DB; resumable; idempotent writes |
| Overbuilding | Ship one block at a time on real data before the next |

## 11. Status of Open Items

**Resolved (2026-07-03):**
- Supabase account: Aryan has one. Vercel: create at Phase 1 deploy step (free tier).
- LLM: OpenAI API key from platform.openai.com needed at Phase 2 (note: ChatGPT Pro subscription does NOT include API access — separate usage-based billing, cost will be trivial). Scaffold with env placeholders.
- Team size: 2–3 users, 4 max. Names/emails at Phase 5.
- Single org confirmed: `890324941` on crm.zoho.com only.
- Policy defaults confirmed: read-only runs skip the approval gate (still logged + reported); owner changes default to no notification email and no cascade (cascade only via book-of-business preset, both as explicit preview toggles); bulk Stage edits admin-only; pre-schedule screenshots stored for every record.
- Project location: `G:\Zoho Automation\zoho-agent\`. Package manager: npm. UI: Tailwind + shadcn-style operational dashboard. Build locally first against cloud Supabase; deploy to Vercel at end of Phase 1.
- KD Blitz values ("1st Email", "2nd Email", CC list, dates/times) are run parameters, always confirmed in preview. Default CC: `ankur@klouddata.com`.

**Still pending:**
1. Account/contact/deal **link CSVs** for initial DB import — Aryan preparing now (Phase 1 step 5).
2. Sample **KD Blitz drafts MD** + **deal links CSV** — Phase 2 parser testing.
3. OpenAI **API key** — Phase 2.
4. User names/emails/roles — Phase 5.

## 12. Working Agreements (for any chat/dev executing this)

1. Follow this document; deeper detail lives in `workflows/` and `reference/` — read those before building the related component.
2. Build in the phase order; a phase must work on real data before the next starts.
3. Never bypass: preview → approval → execute → verify → report.
4. Test every executor block on 1–2 records before any batch.
5. All Zoho writes verified by read-back; all failures carry evidence; all reports carry exact counts and skip reasons.
6. Update this file's Status line and Section 11 as items complete.
