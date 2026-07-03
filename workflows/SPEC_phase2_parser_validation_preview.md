# Phase 2 Build Spec — Command Parser, Validation Engine & Preview

Version 1.0 (2026-07-04). For Codex. Build on the existing `zoho-agent` app (Phase 1 complete).
Read first: `ZOHO_AGENT_WORK_PLAN.md` §5–6, `SPEC_llm_provider_codex_subscription.md`, `SPEC_kd_blitz_email_scheduling.md`, `SPEC_record_editing.md`, `reference/ZOHO_SESSION_API_REFERENCE.md`.

## 0. Goal & boundary

Turn a user's free-text command + attached file into a **validated, previewable execution plan** — and stop there. Phase 2 touches **no Zoho** and performs **no writes to CRM**. It reads only our own Supabase data (records + field metadata) and the user's LLM credential. Execution is Phase 3.

End state: a user types "Set Next Step to 2nd Email for the KD Blitz deals" (or uploads a batch CSV), picks which action blocks run, sees a per-record preview with warnings/skips, and clicks Approve — which creates a `workflow_runs` row in status `preview_ready`/`approved`. That's the Phase 2 finish line.

## 1. Data flow (the 6 Phase-2 steps of the pipeline)

```
command + files ──▶ [1 parse: user's LLM] ──▶ plan JSON
                          │
                    [2 resolve]  enrich records from DB (accounts/contacts/deals), map names→our rows
                          │
                    [3 validate] deterministic rules per block per record (uses zoho_field_meta)
                          │
                    [4 preview]  per-record table + toggles + run-parameter confirm + warnings/skips
                          │
                    [5 approve]  explicit; creates workflow_run + workflow_run_items (status pending)
                          │
                    [6 dry-run]  optional: same as preview, produces downloadable plan CSV, no run created
```

Steps 7–9 (execute / verify / report) are Phase 3.

## 2. Plan JSON schema (parser output contract)

The LLM returns **only** this JSON (no prose). Zod-validate it on receipt; malformed → treat as parse failure with a friendly retry.

```jsonc
{
  "intent_summary": "string — one line restating what the user asked, for the preview header",
  "run_kind": "read | write",
  "blocks": [
    { "slug": "update_deal_field", "config": { "field_api_name": "Next_Step", "value": "2nd Email" } }
  ],
  "record_selector": {
    "mode": "tag | ids | names | file | filter",
    "tag": "KD Blitz",                       // when mode=tag
    "module": "deals | contacts | accounts",
    "values": ["..."],                        // ids/names/urls when applicable
    "filter": { "field": "stage", "op": "equals", "value": "Follow-Up" } // when mode=filter
  },
  "run_parameters": { "cc": ["ankur@klouddata.com"], "schedule_time": "20:00", "schedule_date": "2026-07-07" },
  "warnings": ["free-text notes the model wants surfaced"],
  "missing_info": ["questions to ask the user when the command is underspecified"]
}
```

Rules the parser must follow (enforced in the system prompt AND re-checked in code):
- **Never invent records, IDs, emails, dates, or field values.** If the command doesn't supply something a chosen block requires, put a question in `missing_info` and do NOT fabricate.
- If the command maps to no known block, or is vague ("clean up Zoho", "do the campaign"), return empty `blocks` + a clarifying `missing_info`. Never guess a destructive action.
- Only emit block slugs that exist in `action_blocks`. Only emit field api_names that exist in `zoho_field_meta` for that module.
- `run_kind=read` for pure listing/report commands (e.g. "list IT contacts"); those skip the approval gate later.

## 3. Parser (LLM) implementation

- Resolve the **triggering user's** credential per `SPEC_llm_provider_codex_subscription.md`. No global key.
- System prompt is assembled server-side from live data, not hardcoded:
  - The `action_blocks` catalog (slug, name, module, required_inputs, admin_only) from DB.
  - The `presets` list (name, slug, block_chain) so "KD Blitz" resolves to its chain.
  - The available tags (distinct `tags`/`matched_tags` from accounts/deals/contacts) so tag selectors validate.
  - Per-module editable field api_names + picklist options from `zoho_field_meta`.
  - The hard rules from §2 restated as instructions, plus: output JSON only, matching the schema.
- Attached files: parse CSV (existing `lib/import/csv.ts`) and MD drafts (new `lib/parsers/drafts-md.ts`) to text/rows and include a **truncated** representative sample in the prompt (cap tokens; send row count + columns + first N rows, not the whole file). The full file stays server-side for validation.
- Request the model in JSON mode / with a strict schema; low temperature.
- Guardrails in code after the model returns: Zod schema check → block slugs exist → field api_names exist → admin_only blocks require admin role (else move to `missing_info`/blocked). The model is never trusted to enforce these alone.

## 4. Resolve step (deterministic, our DB only)

Given `record_selector`, produce the concrete target rows from Supabase:
- `mode=tag` → rows where `tags`/`matched_tags` contains the tag (module-specific).
- `mode=ids` → match `zoho_*_id`; `mode=names` → match name with the proven fallbacks (exact → normalized/starts-with); **ambiguous or multiple matches → mark row `needs_review`, never auto-pick.**
- `mode=file` → each CSV/MD row becomes a target; join to DB records by id/email/name to enrich (and to catch "not in our data" warnings).
- `mode=filter` → simple field filters over our tables.
- For email scheduling: expand per contact (contacts on the deal/account or from the batch file); a deal with no eligible contact is a skip with reason.
- Output: an in-memory list of `{ record_type, record_key, our_row, source_row }` — not yet persisted.

## 5. Validation engine (deterministic, per block, per record)

One rule module per block under `lib/validation/`, driven by the block's `validations` array + `zoho_field_meta`. Each record gets a status + reasons. Rules to implement for the v1 blocks:

- **update_deal_field / update_account_fields / update_contact_fields:** record resolved & unambiguous; field api_name valid for module; if picklist, value ∈ allowed options; value present; `Stage` edits require admin (block is `admin_only` for Stage per plan). Email fields must be valid format.
- **change_owner:** target owner resolves to a known user (from a users list — Phase 2 can validate against a seeded owner map: Aryan/Linda/Ankur + ids from `reference`); flag cascade/notification options explicitly.
- **add_tags / remove_tags:** tag name present; record resolved.
- **create_task:** subject present; due_date valid/parseable; record resolved; duplicate-task check is deferred to Phase 3 (needs live Zoho) but flag if our DB already shows a matching task.
- **complete_task:** subject present; record resolved (actual open-task match is Phase 3).
- **schedule_email:** recipient email present & valid; subject present (first option per KD Blitz rule); body present; schedule_date/time present & in the future; CC confirmed (run parameter); contact/deal linkage present; `email_opt_out` must be false (skip opted-out); missing-email contacts → skip with reason. Duplicate-scheduled-email check deferred to Phase 3.

Each record ends as `success-eligible | skipped | needs_review` with human-readable reasons. Batch-level counts computed. **Nothing is validated as "done" — this only decides what WOULD run.**

## 6. Preview UI (`app/run/new` → results, and `app/run/[id]`)

- Command box + file attach + optional preset picker. Submit → calls parse+resolve+validate route → renders preview.
- **Block toggles:** show the blocks the parser chose; user can enable/disable each and edit its config inline. Re-validates on change.
- **Run-parameter panel:** CC, schedule date/time, task subject, Next Step value, owner — shown as editable fields the user must confirm (never assumed). For schedule_date, show a note to confirm against the live CRM clock.
- **Per-record table:** row #, record name + Zoho link, blocks to apply, resulting action/values, status badge (eligible/skip/needs-review), warnings. Sortable/filterable by status.
- **Summary bar:** total, eligible, skipped, needs-review counts + estimated actions.
- **Actions:** Approve (write runs only, creates the run) · Dry run (produces downloadable plan CSV, no run) · Cancel · Fix input. Read-kind runs show "Run report" instead of Approve (no gate) but still Phase 3 for execution.
- Reuse Phase 1 components (status-badge, page-header, tables). Keep it operational, not flashy.

## 7. API routes (all require session; use per-user LLM credential)

- `POST /api/plan/parse` — body: command + file refs. Returns plan JSON (or missing_info). Logs `audit_events` `llm_parse`.
- `POST /api/plan/validate` — body: plan JSON (+ toggles/params). Returns resolved+validated preview payload. Pure DB, no LLM.
- `POST /api/runs` — body: approved plan + preview. Creates `workflow_runs` (status `approved` for write, `preview_ready` for read) + `workflow_run_items` (status `pending`). Enforces role (operator/admin) and admin-only blocks. Logs `audit_events` `run_created`.
- `GET /api/runs/:id` — run + items for the run detail page.
- Settings routes for credentials per the credential spec (`/api/settings/llm/*`): connect ChatGPT (device-code start/poll), add/validate API key, disconnect.

## 8. New/changed files (guide, not exhaustive)

```
lib/llm/openai-codex.ts        per-user codex provider (device-code + refresh)  [per credential spec]
lib/llm/openai-key.ts          per-user api-key provider
lib/llm/resolve-credential.ts  load+decrypt triggering user's credential
lib/crypto/cred.ts             AES-256-GCM encrypt/decrypt (LLM_CRED_ENC_KEY)
lib/parsers/drafts-md.ts       KD Blitz drafts MD → structured contacts
lib/plan/schema.ts             Zod schema for plan JSON
lib/plan/system-prompt.ts      assembles prompt from DB (blocks/presets/tags/fields)
lib/resolve/records.ts         record_selector → concrete targets from DB
lib/validation/*.ts            one module per block + a runner
app/run/new/page.tsx           command box + preview (replace Phase-1 placeholder)
app/run/[id]/page.tsx          run detail
app/settings/page.tsx          OpenAI connection card
app/api/plan/parse/route.ts, app/api/plan/validate/route.ts,
app/api/runs/route.ts, app/api/runs/[id]/route.ts,
app/api/settings/llm/*         connect/validate/disconnect
supabase/2025_phase2.sql       user_llm_credentials table + RLS (per credential spec)
```

## 9. Build order (each step runnable before the next)

1. Migration: `user_llm_credentials` + RLS; `lib/crypto/cred.ts`; `LLM_CRED_ENC_KEY` in `.env.local`.
2. Settings page + credential routes: connect ChatGPT (device-code) and API key, encrypted store, status display. **Verify a real connect end to end.**
3. `resolve-credential` + both providers (codex, api-key) behind `LLMProvider`. Smoke-test `parsePlan` with a trivial command.
4. Plan schema + system-prompt assembly + `/api/plan/parse`. Test 10 real commands parse to valid JSON; vague ones return `missing_info`.
5. Resolve + validation engine + `/api/plan/validate`. Test against real DB (KD Blitz tag → correct deals; a bad field name → rejected; opted-out/no-email contacts → skipped).
6. Preview UI with toggles + run-parameter confirm + per-record table.
7. `/api/runs` approve → creates run + items; run detail page shows them.
8. Dry-run CSV export.

## 10. Done-when (Phase 2 acceptance)

- Each user can connect their own ChatGPT subscription OR API key in Settings; secrets encrypted; status shown; disconnect works.
- 10 varied real commands (field update, owner change, tag, task, email-schedule, "list IT contacts") produce correct validated previews using the triggering user's credential.
- Vague/unknown commands yield clarifying questions, never a runnable destructive plan.
- Validation correctly marks eligible/skip/needs-review with reasons on real data (tags, picklists, opt-outs, ambiguous names).
- Approve creates a `workflow_run` + `workflow_run_items` in `pending`; read-kind runs skip the gate.
- Zero Zoho calls and zero CRM writes anywhere in Phase 2.
- `npm run typecheck`, `lint`, `build` pass; unauthenticated access blocked; admin-only blocks (Stage) enforced server-side.

## 11. Guardrails (carry from Phase 1 working agreements)

Preview → approval before any run row that Phase 3 will execute. LLM never enforces safety alone — code re-checks every constraint. Never fabricate data. Log parses and run creation to `audit_events`, never secrets. Pin any new dependencies to exact versions. Test on real data before declaring a step done.
