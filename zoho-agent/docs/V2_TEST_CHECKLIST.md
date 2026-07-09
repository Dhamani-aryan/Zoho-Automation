# V2 Phase E Regression Checklist

Run this checklist after Phase E build verification. Check items only when tested against the rendered app/extension, not only by DB edits.

## Automated

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run build:extension`
- [ ] `npm run test:orchestrator`
- [ ] `npm run test:records`
- [ ] `npm run test:tier2`

## Phase B Negative Tests

- [ ] Extension disabled/offline: live Zoho read fails before side effects with clear guidance.
- [ ] No `crm.zoho.com` tab: claimed job reports a failed result with the no-tab message.
- [ ] Zoho logged out: extension reports `zoho_logged_out` and chat tells the user to sign back in.
- [ ] Non-allowlisted `zoho_read_api` path is rejected server-side.
- [ ] Non-allowlisted `zoho_read_api` path is rejected extension-side.
- [ ] Timed-out queued job expires after 10 minutes and is visible as expired on session reload.
- [ ] MV3 teardown recovery: leave Chrome idle for 10 minutes, ask a live-read question, and confirm pickup within 60 seconds.

## Phase C Sync

- [ ] Create or tag 2-3 demo records in Zoho.
- [ ] Ask `/agent` to pull that tag into the mirror.
- [ ] Confirm inserted/updated/unchanged counts are reported.
- [ ] Confirm Records browser shows the records.
- [ ] Re-run the same sync and confirm it is idempotent, with unchanged records reported.

## Phase D Approval-Gated Writes

- [ ] Rendered UI approval approve path: while the agent turn is waiting, click Approve in the browser approval card. Confirm the card is clickable, the write executes, and read-back verification succeeds.
- [ ] Rendered UI approval reject path: while the agent turn is waiting, click Reject in the browser approval card. Confirm no write job is created and chat acknowledges rejection.
- [ ] Identity mismatch: change the record name in Zoho after the card appears but before approval/execution, then approve. Confirm the extension aborts with `identity_mismatch` before writing.
- [ ] Verify failure: force a read-back mismatch on a demo record and confirm `verify_failed` plus partial per-record results are visible in the report payload.
- [ ] Expired approval: let a card sit for more than 15 minutes, reload the session, and confirm the card is expired and cannot enqueue a write.
- [ ] No approval refused: manually create or simulate a Tier-2 `tool_jobs` row without `approval_id`; claim must refuse it.
- [ ] Wrong user approval refused: approval by a different user returns 403 and creates no job.
- [ ] Extension refusal: write job without `approval_id` is refused by the extension even if handed out.

## Phase E Hardening

- [ ] Env defaults match current behavior with no env overrides: 15 tool calls, 180000ms turn timeout, 90000ms job wait, 120000ms extension liveness.
- [ ] Override `AGENT_MAX_TOOL_CALLS` with a low value and confirm the agent stops at that budget.
- [ ] Override `AGENT_TURN_TIMEOUT_MS` with a low value and confirm the stop message uses the configured seconds.
- [ ] Override `AGENT_JOB_TIMEOUT_MS` with a low value and confirm bridged job wait expires on that budget.
- [ ] `/admin/agent-activity` is unavailable to non-admin users.
- [ ] `/admin/agent-activity` shows filtered agent activity, per-user counts, and latest failures for admin.
- [ ] Archived sessions older than 30 days are purged only after clicking the admin button and confirming the browser dialog.
- [ ] Purge is never automatic on page load.
- [ ] `/agent` is the post-login and root landing page.
- [ ] `/run/new` still works by direct URL and the batch pipeline preview to save path is unbroken.
- [ ] Primary navigation no longer promotes `/run/new`.
- [ ] Extension options page shows the last 10 agent job statuses.

## Credential Refresh

- [ ] ChatGPT/Codex credential refresh rotation still works after token expiry.
- [ ] API-key provider still uses the configured or default model.

## One-Day Acceptance

- [ ] Aryan uses the app for one full day with real queries.
- [ ] Zero unexplained failures remain.
- [ ] Any deferred issue is logged in `docs/V2_DECISIONS.md` with owner and reason.
