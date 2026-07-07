# V2 Phase F Build Spec — UI Navigation + Teachable Workflows

Version 1.0 (2026-07-08). For Codex. Prereq: Phase E reviewed.
Read first: SPEC_v2_tool_agent_migration.md §3b (the requirement + storage, already migrated), workflows/SPEC_kd_blitz_email_scheduling.md §9 (proven Zoho selector map + interaction quirks), docs/V2_DECISIONS.md.

## 0. Goal & boundary

Aryan teaches a Zoho UI flow ONCE (guided in chat, or by recording his own clicks); the agent saves it parameterized and replays it unaided later. Read-effect replays are Tier 1; write-effect replays (anything changing CRM state, incl. schedule email / complete task) go through the Phase D approval card. Acceptance = migration spec Phase F done-when.

## 1. UI step executor (extension)

New `extension/src/page-runner-ui.ts` (MAIN world, self-contained) executing ONE step per call:
`wait_for {selector|text, timeout≤10s}`, `click {selector|text}`, `fill_field {selector, value}` (native setter + input events + Enter option — Zoho inline edits need real commits, see KD Blitz §8/§9), `read_field {selector}`, `press_key {key}`, `confirm_text_present {text}`, `verify_field {selector, equals}`.
Background-side steps (not in page runner): `open_url {url}` via `chrome.tabs.update` + completion wait; `screenshot` via `chrome.tabs.captureVisibleTab` (PNG base64, capped 500 KB, stored as tool_job evidence).
Every step returns `{ ok, observed?, error_message? }`; jobs.ts gets a `ui_step`/`ui_workflow` job type routed to this runner. Selector allow-nothing: steps run only on crm.zoho.com tabs (enforced in background before dispatch).

## 2. Tools

- `ui_step { step }` — Tier 2-teach-only: executable ONLY while the session is in teach mode (server-checked flag, §3); each call = one live step the user watches.
- `save_ui_workflow { name, description, steps[], params: [{name, description, example}], effect: read|write }` — validates steps against the vocabulary; literals the agent proposes as `{param}` slots; upserts `ui_workflows` (version bump on same name); requires user confirmation card (reuse approval-card UI with decision `approve|reject`, kind `save_workflow`).
- `list_ui_workflows {}` — Tier 0 (DB read).
- `run_ui_workflow { name, params }` — resolves workflow, substitutes params (reject unknown/missing), then: effect=read → Tier-1 bridged job executing steps sequentially; effect=write → Phase D approval card first (summary = step list with substituted values), then execution. Step failure → stop, report step index + evidence screenshot. First-ever replay of a workflow runs with `trusted=false` warning in chat; a fully verified replay sets `trusted=true`.

## 3. Teach mode

Migration `2026_v2_phase_f.sql`: `alter table agent_sessions add column if not exists teach_mode boolean not null default false;`
- Chat toolbar button "Teach a workflow" → `PATCH /api/agent/sessions/[id]` toggles `teach_mode` (owner only). Banner shown while active.
- Loop: `ui_step` allowed iff session.teach_mode; instructions extended: in teach mode, execute exactly ONE ui_step per user instruction, show the observed result, accumulate the verified step list, propose parameterization at "save it".
- Recorder mode (build LAST, only after guided teaching works): options-page Start/Stop recording → content script captures click/input events (selector derivation: id > name > shortest unique CSS path; NEVER capture password fields) into chrome.storage; "Import recording" in chat hands the raw steps to the agent to clean/parameterize → `save_ui_workflow` confirmation. Raw recordings discarded after save/discard.

## 4. Build order

1. Migration + teach-mode toggle + banner.
2. UI step vocabulary types + Zod; `page-runner-ui.ts` + jobs routing; `ui_step` tool behind teach mode. Live-teach test: "open the Duraco deal, read Next Step" step by step.
3. `save_ui_workflow` + confirmation card + `list_ui_workflows`.
4. `run_ui_workflow` read-effect replay + trusted flag + evidence. Done-when test 1: teach once on record A, replay unaided on record B.
5. Write-effect replay through the Phase D approval path. Done-when test 2: a task-complete workflow replays only via card.
6. Recorder mode (stretch — defer without guilt if time-boxed out; log the deferral).

## 5. Done-when

Migration spec Phase F done-when + step evidence stored + teach-mode server enforcement proven (ui_step outside teach mode → error observation) + typecheck/lint/build/build:extension green + V2_DECISIONS logged.

## 6. Review checklist

Teach-mode server-side gating; write-effect classification honesty (any step that can mutate → effect=write enforced at save time: fill_field/click imply write unless agent justifies read + user confirms); param substitution injection-safety (params only into value/url/text slots, never selectors); screenshot size caps; recorder never captures passwords; page-runner-ui closure-free.
