# V2 Phase C Build Spec — Mirror Sync from Live Zoho

Version 1.0 (2026-07-08). For Codex. Prereq: Phase B reviewed + live reads working.
Read first: SPEC_v2_tool_agent_migration.md §3 (Tier 1), docs/V2_DECISIONS.md, reference/ZOHO_SESSION_API_REFERENCE.md §5 (field maps).

## 0. Goal & boundary

Acceptance scenario 2: "I added new accounts in Zoho with tag Q3 Prospects — pull them in." → agent chains `zoho_search(tag)` (paginating) → `db_sync_records` → answers "9 new, 3 updated" with names. LOCAL DB writes only — still zero Zoho writes. `db_sync_records` is Tier 1 by locked decision (mirror upsert ≠ CRM write).

## 1. New lib: `lib/records/zoho-upsert.ts`

Maps LIVE Zoho API records (NOT the CSV-export shape the import script uses) → mirror rows:
- accounts: `id→zoho_account_id`, `Account_Name→account_name`, Website, Phone, Industry, `Owner.name→owner`, full record → `raw_data`, `zoho_url` composed from id (`.../tab/Accounts/{id}`).
- contacts: `id→zoho_contact_id`, Full_Name/First/Last, Email, Title, Phone, Mobile, Owner.name; `Account_Name.id` → resolve mirror `accounts.id` FK by `zoho_account_id` (unresolved → row synced with null FK + warning).
- deals: `id→zoho_deal_id`, Deal_Name, Stage, Next_Step, Amount, Closing_Date, Owner.name; `Account_Name.id`/`Contact_Name.id` → FK resolution, same warning rule.
Upsert on the zoho_* id (onConflict). Classify per row: inserted | updated (any mapped column changed) | unchanged. Return `{ inserted[], updated[], unchanged_count, warnings[] }` with record names.
NOTE: do NOT touch `scripts/import-masters.mjs` (CSV shape differs). Add a code comment cross-referencing both; unification is a Phase E backlog item.

## 2. Tool: `db_sync_records` (Tier 1, in-process — no extension job)

Args (Zod + JSON schema): `{ module: accounts|contacts|deals, records: object[] (1–200, each must have string id) }`.
Execution: role operator/admin (loop already guarantees); service client for the upsert AFTER validation; audit `mirror_sync` with counts. Result = the §1 report (truncation-safe: names capped at 50, rest counted).
Prompt additions: after live searches that reveal records missing/stale in the mirror, offer to sync; for tag pulls, paginate `zoho_search` until `more_records=false`, then sync ALL pages in ≤200 chunks; report counts + names; never sync records the user didn't ask about.

## 3. Build order

1. `zoho-upsert.ts` + unit tests (node:test, same harness as orchestrator): insert/update/unchanged classification, FK resolution, unresolved-FK warning, bad-record rejection.
2. Tool definition + loop wiring + prompt update.
3. Live test: Aryan tags 2–3 demo accounts in Zoho with a fresh tag → scenario 2 in chat → verify rows in Records browser + counts correct.
4. Negative tests: >200 records (blocked by schema), record without id (Zod error observation), module mismatch (contact record into deals → upsert fails cleanly with JSON error), unresolved account FK (warning surfaced in chat).

## 4. Done-when

- Scenario 2 end to end on real tag; counts and names correct; re-running reports all-unchanged (idempotent).
- Mirror rows visible in Records browser and usable by Tier-0 tools immediately.
- Unit tests green; typecheck/lint/build green; V2_DECISIONS checkpoint logged.
- Grep-proof: still no Zoho write path anywhere.

## 5. Review checklist (chat will check)

Upsert idempotency; FK resolution correctness; no service-client use before validation; raw_data preserved complete; tag pagination actually loops; audit rows written.
