# Phase 3 Build Spec — Chrome Extension + Live Zoho Execution (API blocks)

Version 1.0 (2026-07-05). For Codex. Build on the existing `zoho-agent` app (Phases 0–2 complete and tested on real data).
Read first: `ZOHO_AGENT_WORK_PLAN.md` §2–§6, `reference/ZOHO_SESSION_API_REFERENCE.md` (the execution bible for this phase), `workflows/SPEC_record_editing.md`, `zoho-agent/docs/PHASE_2_DECISIONS.md` (especially the 2026-07-05 entries — the engineering invariants in them are binding here).

## 0. Goal & boundary

Turn an **approved** preview run into real, verified Zoho changes — executed inside the user's own logged-in Zoho browser session by a Chrome extension, one record at a time, with read-back verification and a full report.

Phase 3 scope: **session-API blocks only** — `update_deal_field`, `change_owner`, `update_contact_fields`, `update_account_fields`, `add_tags`/`remove_tags`. First live block is `update_deal_field` (Deal `Next_Step`). UI-automation blocks (tasks, email scheduling) are **Phase 4 — do not build them here**.

Hard boundaries, unchanged from the locked decisions:
- Nothing executes without an explicit Approve click on a preview (server-enforced, not just UI).
- No deletes. No record creation. No Stage bulk edits except by admin. No modules beyond Deals/Contacts/Accounts. Org `890324941` on `crm.zoho.com` only.
- The extension executes only runs **triggered by the same user** whose token it holds.
- Every write is verified by re-reading the record. No verification = not reported as success.

## 1. How execution works (data flow)

```
Web app                     Backend (Next.js API)                 User's Chrome
────────                    ─────────────────────                 ─────────────
preview → Approve ──────▶ run: preview_ready → approved
                          items: pending
                                                                  extension polls (token auth)
                          POST /api/ext/claim  ◀───────────────── background worker
                          returns 1 item (pending → running)
                                                                  content script in the Zoho tab:
                                                                    read record (before)
                                                                    identity check (name matches)
                                                                    PUT via session API
                                                                    re-read record (verify)
                          POST /api/ext/report ◀───────────────── result + before/after + evidence
                          item → success/failed/skipped
                          totals updated, stop rules checked
                          … repeat until no pending items …
                          run → completed (or paused/stopped)
run detail page polls GET /api/runs/:id → live progress → final report + CSV
```

The backend serves **one item at a time** per claim. The extension composes the fixed API-step primitives (`api_read`, `api_search`, `api_update`, `api_tag`, `api_verify`) into the right sequence for the item's block. Sequential execution; no parallelism in v1.

## 2. Database migration (`supabase/2026_phase3.sql`)

```sql
-- Extension pairing tokens. The plaintext token is shown ONCE in Settings;
-- only its sha256 hex digest is stored.
create table if not exists public.user_extension_tokens (
  user_id uuid primary key references public.users(id) on delete cascade,
  token_hash text not null,
  label text,
  status text not null default 'active',   -- active | revoked
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
alter table public.user_extension_tokens enable row level security;
create policy "own ext token read" on public.user_extension_tokens
  for select to authenticated using (user_id = auth.uid());
-- writes only via server routes on the service key

-- Run lifecycle columns
alter table public.workflow_runs
  add column if not exists approved_by uuid references public.users(id),
  add column if not exists approved_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists stop_reason text;

-- Item execution columns
alter table public.workflow_run_items
  add column if not exists attempts int not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists executed_at timestamptz,
  add column if not exists verified boolean,
  add column if not exists evidence jsonb;
```

Run **statuses** (superset of Phase 2): `draft`, `preview_ready`, `approved`, `running`, `paused`, `completed`, `failed`, `cancelled`.
Item statuses: `pending`, `running`, `success`, `skipped`, `failed`, `needs_review`.

State machine (enforce in `lib/orchestrator/state.ts`, pure functions, unit-testable):
- `preview_ready → approved` (approve route; write runs only — read runs skip the gate per Phase 1 decision 11)
- `approved → running` (first successful claim)
- `running → paused` (stop rule hit, logged-out report, or manual pause)
- `paused → running` (manual resume; remaining items only)
- `running → completed` (no pending/running items left)
- `approved|running|paused → cancelled` (manual)
- Items: `pending → running` (claim) → `success | failed | skipped` (report). A `running` item whose claim is older than 5 minutes is reclaimable (crash recovery). `attempts` increments per claim; max 2 attempts, then auto-`failed`.

**Stop rules** (checked server-side on every report): 3 consecutive `failed` items, or failure rate > 20% once ≥ 10 items are done, or any report flagged `stop_run: true` (identity mismatch, logged-out). Effect: run → `paused` with `stop_reason`; the user decides on the run page (resume / cancel).

## 3. Backend routes

All routes follow the Phase 2 invariants (binding, from PHASE_2_DECISIONS 2026-07-05): every handler wraps its risky section in try/catch and returns the real error as JSON — never a bare 500; all upstream fetches have explicit timeouts; error strings are strings, never objects.

### Session-authenticated (web app)

- `POST /api/runs/:id/approve` — role operator/admin; only the run's `triggered_by` or an admin; only from `preview_ready`; only `run_kind='write'` requires it. Blocks containing admin-only actions (Stage edits) require admin. Sets `approved_by/approved_at`. Audit `run_approved`.
- `POST /api/runs/:id/pause` / `resume` / `cancel` — same permission rules; audit each.
- `GET /api/runs/:id` — extend the existing route to include live totals + per-item status + `stop_reason` (the run page will poll this every 3–5 s while `running`).
- `GET /api/runs/:id/report.csv` — streams the final CSV: row per item — record name, Zoho URL, block, action, status, before, after, verified, error, executed_at.
- `POST /api/settings/extension/token` — generates `zext_` + 32 random hex chars, stores sha256, returns plaintext **once**. Regenerating revokes the old one. `DELETE` revokes.

### Token-authenticated (extension) — new namespace `/api/ext/*`

Auth: `Authorization: Bearer zext_...` header. Resolve sha256 → `user_extension_tokens` (status active) → user. Unknown/revoked token → 401 JSON. Update `last_seen_at`. These routes use the service-role client **after** that check; they never trust client-sent user ids.

- `POST /api/ext/handshake` → `{ user: {id, name}, approved_runs: [{id, blocks, item_counts}] }`. Lets the options page show "connected as Aryan, 1 run waiting".
- `POST /api/ext/claim` — body `{ run_id }` → claims the next `pending` item of that run **iff** run is `approved`/`running` AND `triggered_by` = token user. Returns `{ item, run_context }` where `item` = id, row_number, block_slug, record_type, zoho record id + URL, expected record name, config (field/value/owner/tags), and `run_context` = org id, allowed module, run status. No pending items → `{ item: null, run_complete: true|false }`. Marks run `running`+`started_at` on first claim.
- `POST /api/ext/report` — body `{ item_id, status, before_data, after_data, verified, error_message, evidence, stop_run? }`. Validates the item is `running` and belongs to the token user's run. Applies state machine + stop rules, updates totals, finalizes the run when done (`completed_at`). Audit `item_executed` / `run_paused` / `run_completed`.

## 4. Chrome extension (`extension/`, Manifest V3, plain TypeScript compiled with esbuild — pin the version)

```
extension/
├── manifest.json          MV3; host_permissions: https://crm.zoho.com/*, http://localhost:3000/*
├── src/background.ts      polling loop (chrome.alarms every 10s when enabled), claim/report calls,
│                          finds or requires an open crm.zoho.com tab, messages the content script
├── src/content.ts         runs on crm.zoho.com; executes one item per message; owns the CSRF token
├── src/zoho-api.ts        session-API client: headers, read, search, update (≤100 chunk), tags, verify
├── src/executors.ts       per-block executors composed from the api primitives
├── src/options.html/.ts   backend URL + extension token (chrome.storage.local), handshake status,
│                          enable/disable execution toggle
└── build.mjs              esbuild bundling to dist/
```

Key implementation facts (all from `reference/ZOHO_SESSION_API_REFERENCE.md` — follow it exactly):
- Headers for every call, built in the content script from the live page: `X-ZCSRF-TOKEN: crmcsrfparam=<value of hidden input #token>`, `X-CRM-ORG: 890324941`, `X-Requested-With: XMLHttpRequest`; `Content-Type: application/json` on writes; `credentials: 'include'`.
- Read/search on `/crm/v3/...`, writes on `PUT /crm/v2.2/{Module}` with `{data:[{id, ...fields}]}`; deals module is **`Deals`** in the API even though URLs say `Potentials`. Per-record result `code === 'SUCCESS'`.
- Tags via `POST .../actions/add_tags` / `remove_tags`, never field PUT.
- HTTP 204 = no match. Special characters in search criteria → 400; fall back to `starts_with` + client-side filter.
- **Logged-out detection:** missing `#token`, a redirect to accounts.zoho.com, or 401 → report `stop_run: true` with `error_message: 'zoho_logged_out'`; do not retry.
- Every OpenAI-style lesson applies: every fetch has an AbortController timeout (15 s reads, 30 s writes); every error surfaced verbatim into the item report.

**Per-item execution sequence (`update_deal_field` — the template for all field blocks):**
1. `api_read` the record (`fields=` the target field + `Deal_Name`/`Account_Name` + `Owner`) → `before_data`.
2. **Identity check:** record's name must match the item's expected name (case-insensitive, trimmed). Mismatch → `failed` + `stop_run: true`, evidence = both names. Never write.
3. Idempotency: if the field already equals the target value → report `success`, `verified: true`, evidence `already_set` (safe resume behavior).
4. `api_update`: `PUT /crm/v2.2/Deals` `{data:[{id, Next_Step: "2nd Email"}]}` → require `code === 'SUCCESS'`.
5. `api_verify`: re-read the field; value must equal the target → `verified: true`, `after_data`. Verification failure after one retry → `failed`.
6. Report with before/after + evidence (raw API result codes, timestamps).

**Other blocks** (same skeleton, ship in this order after update_deal_field is proven):
- `change_owner`: config carries owner name + id (backend resolves via `KNOWN_OWNERS`; Linda Spione = `6834250000003103001`; full list via `GET /crm/v3/users?type=AllUsers&per_page=200` if needed). Write `{id, Owner: {id: userId}}`; verify `Owner.name`. No notification email, no cascade — API default, matches locked decision.
- `update_contact_fields` / `update_account_fields`: config may carry multiple field/value pairs; one PUT; verify each field.
- `add_tags` / `remove_tags`: tag actions endpoint; verify by re-reading `Tag[]` contains / no longer contains.
- `assign_book_of_business` preset (stretch, only if all above are live): Accounts → Contacts → Deals owner change with per-module verified counts; children enumerated via `/Accounts/{id}/Contacts` and `/Deals`.

## 5. Web app changes

- **Run detail page** (`app/run/[id]`): Approve / Pause / Resume / Cancel buttons per status + role; live-polling item table (status badges, verified column, error messages); totals bar; `stop_reason` banner when paused; CSV download when finished. Reuse Phase 1/2 components.
- **Settings**: new "Chrome extension" card — generate/revoke token (plaintext shown once with a copy button), connection status from `last_seen_at` ("Extension last seen 12 s ago").
- **Runs list**: show new statuses.

## 6. Build order (each step runnable before the next)

1. Migration + orchestrator state machine (`lib/orchestrator/state.ts`) with unit tests for every transition and stop rule (plain vitest or node:test — pin whichever is added).
2. Extension token: settings card + generate/revoke route + hashed storage. Verify a real generate/copy/revoke cycle.
3. `/api/ext/handshake` + `/api/ext/claim` + `/api/ext/report` with token auth; exercise with curl against a manually approved run (no extension yet).
4. Approve/pause/resume/cancel routes + run detail page controls + live polling UI.
5. Extension skeleton: manifest, options page, handshake ("connected as …"), background polling loop that claims and immediately reports `skipped` (dry wiring, no Zoho calls).
6. `zoho-api.ts` + `update_deal_field` executor. **First live test: ONE deal, Next_Step, on a real record chosen by Aryan** (working agreement 4: 1–2 records before any batch). Verify in Zoho UI by eye + in the report.
7. Batch test: 20+ deal Next_Step run end-to-end → verified before/after on every row, accurate report, CSV export. **This is the Phase 3 acceptance gate from the work plan.**
8. Interrupt/resume test: kill the extension mid-run → reclaim after 5 min → idempotent completion (`already_set` rows). Logged-out test: log out of Zoho mid-run → run pauses with `zoho_logged_out`.
9. `change_owner`, then `update_contact_fields`/`update_account_fields`, then tags — each proven on 1–2 records, then a small batch.
10. (Stretch) book-of-business preset with per-module counts.

## 7. Done-when (Phase 3 acceptance)

- A 20+ record `update_deal_field` (Next Step) run completes with verified before/after on every record and an accurate report + CSV. (Work plan §8 Phase 3 done-when.)
- Approve gate enforced server-side: an unapproved run cannot be claimed, a reviewer cannot approve, another user's extension token cannot claim it.
- Stop rules demonstrably fire: identity mismatch pauses the run; 3 consecutive failures pause the run; logged-out pauses the run. Paused runs resume cleanly and never double-apply (idempotency proven).
- `change_owner` and tags blocks live and verified on real records.
- `npm run typecheck` / `lint` / `build` pass; extension builds reproducibly; no new global secrets (extension token hashed; nothing in the extension bundle but the user's own pasted token in chrome.storage.local).
- Zero UI-automation code (that's Phase 4). Zero deletes anywhere. Every failure carries evidence.

## 8. Guardrails (binding, carried from working agreements + Phase 2 lessons)

1. Preview → approval → execute → verify → report. Never bypass, never reorder.
2. Server re-checks everything the extension asserts; the extension is untrusted input.
3. Test every executor on 1–2 real records before any batch. Aryan picks the guinea-pig records.
4. Every API route returns JSON errors with the real reason (`console.error` with a `[tag]` prefix); every client/extension handler uses try/catch/finally around fetches; every upstream fetch has a timeout. A config error must fail BEFORE any side-effecting call.
5. Chunk ≤ 100; writes idempotent; interrupted runs resumable; ambiguity → needs_review, never a guess.
6. Update `ZOHO_AGENT_WORK_PLAN.md` status + `docs/PHASE_3_DECISIONS.md` (create it, same style as Phase 2's) as steps complete. Log every fix and decision there — the chat reviews against it.
7. Git commits authored as "Aryan Dhamani <aryan@klouddata.com>", no AI co-author. Pin any new dependency to an exact version.
