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
