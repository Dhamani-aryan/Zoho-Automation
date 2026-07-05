# Phase 3 Decisions

Confirmed on 2026-07-05.

1. Phase 3 steps 1-5 can start before the remaining Phase 2 acceptance tests because they make zero Zoho calls.
2. The hard gate is before the first live Zoho write: remaining Phase 2 acceptance tests must pass, especially vague-command questions and bad-field rejection.
3. First live executor tests use demo records only. Demo records must exist in Zoho org `890324941` and be imported into Supabase before step 6.
4. The extension defaults to `http://localhost:3000`, editable in the options page.
5. The extension is tested unpacked in Aryan's normal Chrome profile with his existing `crm.zoho.com` login.
6. Phase 3 migration is run manually in Supabase SQL Editor, same process as Phase 2, and must be idempotent.
7. No restore logic is needed for demo records. If a real record is ever used later, restoration is a second one-record run.

## Step 1: Migration and State Machine

Added `supabase/2026_phase3.sql` for extension token storage and live execution columns. The migration is additive/idempotent and includes the canonical Phase 3 `cancelled` enum value while leaving the existing `canceled` value untouched for backward compatibility.

Added a pure orchestrator state module in `lib/orchestrator/state.ts` with unit coverage for run transitions, approval eligibility, claim/reclaim rules, item report transitions, stop rules, and completion/paused outcomes. Tests use Node's built-in test runner through `npm run test:orchestrator`.

## Step 2: Extension Token Pairing

Added `POST/GET/DELETE /api/settings/extension/token`. The plaintext token is generated as `zext_` plus 32 random bytes in hex, returned only from the generate response, and stored as a SHA-256 hash in `user_extension_tokens`. Regenerating replaces the stored hash for the current user; revoke sets status to `revoked`.

Added a Settings card for the Chrome extension with token generate/rotate, one-time copy, revoke, status, label, and last-seen display. The card is local-first: it prepares for the extension handshake without requiring any Zoho call.

## Step 3: Extension API Routes

Added token-authenticated `/api/ext/handshake`, `/api/ext/claim`, and `/api/ext/report`. The shared auth helper accepts only `Authorization: Bearer zext_...`, hashes the token, resolves an active `user_extension_tokens` row plus active `public.users` profile, updates `last_seen_at`, and only then returns the service-role client. Extension routes never trust client-sent user ids.

`claim` serves one item at a time for runs owned by the token user and only when the run is `approved` or `running`. It starts approved runs on first claim and supports stale running-item reclaim after five minutes with the Step 1 attempt cap. `report` accepts terminal item statuses, writes before/after/evidence/verified fields, recomputes totals, applies stop rules, pauses/completes runs, and writes audit events.
