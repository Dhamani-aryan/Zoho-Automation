# Workflow Spec: Record Editing (Accounts / Contacts / Deals)

Sources: `Zoho CRM - Deals Editing Playbook.md`, `Zoho CRM - Contacts Editing Playbook.md`, `Zoho CRM - Accounts Editing Playbook.md`
Spec version: 0.1 (Phase 0 draft — review and correct)
Technical foundation: `reference/ZOHO_SESSION_API_REFERENCE.md`

---

## 1. Purpose

Atomic, user-selectable action blocks for editing existing Zoho records — single or bulk — executed through the session API in the user's logged-in browser (UI automation only when explicitly requested).

## 2. Action blocks defined by these playbooks

### Block: `update_fields` (per module: deal / contact / account)
- **Inputs:** record IDs or URLs (or names to resolve), field → new value map. Values typed per field metadata (picklist exact option, date YYYY-MM-DD, lookup {id}).
- **Validations:** record exists; field API name valid (from synced field metadata); picklist value allowed; lookup targets resolve; user confirmed the change set.
- **Execution:** PUT in ≤100 chunks via session API; per-record SUCCESS/fail captured.
- **Verification:** re-read each record; after-value equals requested; before + after stored.
- **Stop:** record not found; >1 ambiguous match; picklist value invalid; failure threshold hit.

### Block: `change_owner` (per module)
- **Inputs:** record IDs/names, target owner (name → resolved to user ID via users API).
- **Notes:** API path does not send notification email and does not cascade to related records — both become explicit options in the run setup (cascade = the book-of-business composite below).
- **Verification:** re-read; `Owner.name` equals target on every record; exact counts reported.

### Block: `add_tags` / `remove_tags` (per module)
- **Inputs:** record IDs/names, tag name(s).
- **Execution:** tag actions endpoint (single or bulk).
- **Verification:** re-read `Tag[]` contains (or no longer contains) the tag.

### Block: `resolve_records` (internal helper, runs during Resolve/Validate)
- Name → ID resolution via search API with the proven fallbacks: exact → `starts_with` clean prefix + client-side filter (special chars break criteria); 204 = no match; multiple matches = needs_review, never auto-pick.
- Children enumeration: `/Accounts/{id}/Contacts`, `/Accounts/{id}/Deals`.
- Title/role filtering (e.g. "IT contacts") with keyword regex per persona; borderline hits flagged for review.

### Composite preset: `assign_book_of_business`
"Assign these accounts + their contacts + their deals to {owner}."
1. Resolve account IDs.
2. Enumerate children per account.
3. `change_owner` on Accounts → Contacts → Deals (chunked).
4. Verify per module; report per-module counts ("44 accounts, 205 contacts, 44 deals → all Linda Spione"); flag accounts with no deal.

## 3. Cross-cutting rules

1. **API-first:** any change expressible as data uses the session API. UI automation only for UI-only actions or explicit "click/show me" requests.
2. Verify-by-read-back after every write; before/after stored in `workflow_run_items`.
3. Chunks ≤100; idempotent writes; interrupted runs resumable (re-run remaining).
4. Ambiguity (multiple matches, fuzzy names, borderline title matches) → `needs_review`, never silent guessing.
5. Exact counts + skip reasons in every report.
6. Field metadata (`/settings/fields`) synced to the database per module so the validator knows real API names, types, and picklist options — including custom fields.

## 4. Example user commands these blocks serve

- "Change the owner of these 44 accounts and everything under them to Linda" → `assign_book_of_business`
- "Set Next Step to 2nd Email for this deal list" → `update_fields` (deals)
- "Update phones for these 125 contacts from this CSV" → `update_fields` (contacts; file Phone→Phone, Mobile→Mobile; skip only if no number at all; report updated vs skipped)
- "Tag these accounts Unbound 100" → `add_tags`
- "List all IT contacts in these accounts" → `resolve_records` + title filter (read-only run)

## 5. Open questions for Aryan

1. Read-only runs (like "list the IT contacts") — should these be workflows too, producing downloadable CSVs with no approval gate? (Recommend yes: same pipeline, skip the approval step.)
2. Owner changes: should "send notification email" / "transfer related items" ever be needed, or is the API behavior (no email, no cascade unless book-of-business) always right?
3. Any fields that should be **locked** from bulk editing in v1 (e.g. Stage?) — the KD Blitz playbook says never change stage during that flow; should stage edits require admin role generally?
