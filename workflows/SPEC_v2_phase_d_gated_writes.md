# V2 Phase D Build Spec — Approval-Gated Zoho Writes

Version 1.0 (2026-07-08). For Codex. Prereq: Phase C reviewed. THE safety-critical phase — expect the strictest review.
Read first: SPEC_v2_tool_agent_migration.md §2/§3 Tier 2 + §8, reference/ZOHO_SESSION_API_REFERENCE.md §4 (writes), docs/PHASE_3_DECISIONS.md (identity check + verify patterns), lib/plan/validation.ts (picklist/email/date rules to reuse).

## 0. Goal & boundary

Acceptance scenario 3: "Set Next Step to 3rd Email on the Duraco deal" → agent resolves record → calls `zoho_update_fields` → approval card in chat (before → after per record) → Approve executes via extension with identity check + read-back verify → agent confirms. Reject path informs the model. **INVARIANT: no Zoho write executes without a `pending_approvals` row flipped to `approved` by the session's own user. Server-enforced, grep-provable.** No deletes, no record creation, no Stage edits for non-admins, `Deal_Name` edits blocked, org/modules unchanged.

## 1. Tier-2 tools (`lib/agent/tier2-tools.ts`)

- `zoho_update_fields { module, updates: [{ zoho_id, fields: {api_name: value} }] (1–50) }` — fields validated against zoho_field_meta (existence + picklist membership + email format + date validity, reuse lib/plan/validation.ts rule logic); Stage requires admin role; Deal_Name rejected.
- `zoho_change_owner { module, zoho_ids (1–50), owner_name }` — owner resolved via KNOWN_OWNERS/`lib/constants.ts`; unknown → Zod-style error observation.
- `zoho_add_tags` / `zoho_remove_tags { module, zoho_ids (1–50), tags (1–5) }`.
All validation happens BEFORE the approval card is created (fail-before-side-effects; an invalid call never reaches the user).

## 2. Approval flow

1. Loop meets a Tier-2 call → validate (§1) → build `summary`: per-record `{ zoho_id, name, before, after }` (name+before from mirror when present; else live `zoho_get_record` via the Phase B bridge for ≤10 records, else "unknown — verify in card") → insert `pending_approvals` (immutable args snapshot) → emit SSE `approval_required { approval_id, tool_name, summary }` → persist a tool marker row.
2. Loop waits: poll the approvals row every 1 s, max 15 min (approval wait does NOT count against the 3-min turn budget — pause the clock). Timeout → row `expired`, tool error observation "approval expired".
3. `POST /api/agent/approvals/[id] { decision: approve|reject }` — session-auth; owner only; atomic guarded update (`status='pending'`); audit `approval_decided`.
4. Approved → server enqueues ONE `tool_jobs` row `{ tool_name, args: approved-snapshot, approval_id }`. **The jobs-insert path for Tier-2 names exists ONLY here** (bridge refuses Tier-2 without approval_id; claim route returns Tier-2 jobs only if the referenced approval row is `approved` — belt and braces).
5. Extension executes (§3), reports before/after + verified; loop resumes with the result; rejected → tool error "The user rejected this action."; chat card shows final state either way (state from DB on reload — reconnect-safe).

## 3. Extension write executor

New `extension/src/page-runner-write.ts` (MAIN world, self-contained, same serialization rules):
- Per record: GET current (identity: record name must match summary name when provided — mismatch → abort remaining, report `identity_mismatch`), skip-if-already-equal (idempotent resume), `PUT /crm/v2.2/{Module}` `{data:[...]}` chunk ≤100, require per-record `code==='SUCCESS'`, re-read → verify, collect `{zoho_id, before, after, verified, code}`.
- Tags via `POST .../actions/add_tags|remove_tags`; owner via PUT `{Owner:{id}}`.
- Logged-out / auth failure → error_code `zoho_logged_out`, abort remaining.
- jobs.ts routes write tool names to the write runner ONLY when `job.approval_id` is present; anything else → report failed "write without approval refused by extension".
- 30 s timeout per Zoho call; whole job capped 120 s.

## 4. Chat UI

Approval card component: tool name, per-record table (name, field, before → after), Approve / Reject buttons (POST decision), pending countdown, disabled+final state after decision/expiry; card state rebuilt from `pending_approvals` on session load. Tool trace shows `awaiting_approval` status.

## 5. Build order

1. tier2 definitions + validation + unit tests (validation rules, Stage/Deal_Name blocks, owner resolution).
2. Approvals route + loop wait + SSE + card UI. Test with manual DB flips before any extension work.
3. Expiry sweep (loop-side on wait timeout + on session load).
4. Write runner + jobs.ts routing + claim-route approval check. First live write: ONE demo deal Next_Step. Then scenario 3 full: approve, reject, verify-failure (edit the record mid-flight to force mismatch), logged-out.
5. Negative proofs: Tier-2 job inserted manually without approval_id → claim refuses; approval by a different user → 403; expired approval → job never created.

## 6. Done-when

- Scenario 3 passes on demo records incl. reject + identity-mismatch + verify-failure paths; before/after + verified stored and shown.
- All §5.5 negative proofs pass. Grep-proof: `page-runner-write` is the only PUT/actions path; bridge/claim enforce approval linkage; no Tier-2 execution path bypasses `pending_approvals`.
- typecheck/lint/build/build:extension green; orchestrator + new unit tests green; V2_DECISIONS checkpoint logged.

## 7. Review checklist (chat will check hard)

Approval snapshot immutability (execute EXACTLY what was approved); atomic decision update; approval↔job linkage both sides; identity-check abort semantics; chunking; verify read-back required for `verified:true`; no write reachable in teach/UI paths; budget-pause correctness; SSE reconnect shows correct card state.
