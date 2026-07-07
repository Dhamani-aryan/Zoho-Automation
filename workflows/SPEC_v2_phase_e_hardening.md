# V2 Phase E Build Spec — Hardening + Rollout

Version 1.0 (2026-07-08). For Codex. Prereq: Phase D reviewed.
Read first: SPEC_v2_tool_agent_migration.md §8/§10, docs/V2_DECISIONS.md (all review sections — every "Phase X backlog" item lands here).

## 1. Scope (in build order)

1. **Backlog burn-down** (from review notes): bridge `EXTENSION_LIVE_MS` tuning; drop per-cycle handshake in `jobs.ts` (claim updates last_seen); extension-side `zoho_read_api` allowlist re-check (defense-in-depth); extract claim/sweep decisions into pure lib functions + unit tests (orchestrator pattern); unify CSV-import and zoho-upsert field mappings behind one module.
2. **Sweeps & retention:** approvals `pending` >15 min → `expired` and jobs `queued` >10 min → `expired` also swept on session load (not only claim); `agent_sessions` archived >30 days: admin-visible purge button (hard delete cascades messages) — NOT automatic.
3. **Budgets/env:** `AGENT_MAX_TOOL_CALLS`, `AGENT_TURN_TIMEOUT_MS`, `AGENT_JOB_TIMEOUT_MS`, `CODEX_RESPONSES_URL`, `LLM_MODEL` all env-tunable with current values as defaults; document in `.env.example`.
4. **Admin observability:** `/admin/agent-activity` — audit_events filtered to `agent_turn|tool_call|approval_decided|ext_job_reported|mirror_sync`, per-user counts, latest failures; admin-only route guard.
5. **Surface polish:** `/agent` becomes the post-login landing page; `/run/new` demoted from primary nav (route kept for batch presets); extension options page shows job history (last 10 statuses).
6. **Docs for the team:** one-page user guide (how to pair the extension, ask, read live-vs-mirror labels, approve writes, what stops mean); update HANDOFF.md + ZOHO_AGENT_WORK_PLAN.md status.
7. **Full regression checklist, scripted in docs/V2_TEST_CHECKLIST.md:** all Phase B negative tests; Phase C idempotent re-sync; Phase D approve/reject/mismatch/expired/no-approval-refused; MV3 teardown recovery (idle 10 min → ask → pickup ≤60 s); credential refresh rotation still works; batch pipeline (`/run/new` → preview → save) unbroken.

## 2. Done-when

- Every checklist item in docs/V2_TEST_CHECKLIST.md passes, checked off by Aryan across one full day of real usage with zero unexplained failures.
- All review-backlog items closed or explicitly deferred with a logged reason.
- typecheck/lint/build/build:extension/tests green; V2_DECISIONS final Phase E gate logged.
- Team-rollout precondition noted (NOT built here): Vercel deploy + user 2–3 onboarding remains the old Phase 5, scheduled after Phase F.

## 3. Review checklist

No new tool surface (hardening only); purge is admin-only + confirmed; env defaults match current behavior exactly; checklist file complete and honest.
