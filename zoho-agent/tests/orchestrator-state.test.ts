import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_STALE_MS,
  canApproveRun,
  canClaimItem,
  canClaimRun,
  canReportItem,
  canTransitionRun,
  computeStopDecision,
  nextItemClaim,
  statusAfterClaim,
  statusAfterReport
} from "../lib/orchestrator/state";

test("run transitions allow only the Phase 3 lifecycle", () => {
  assert.equal(canTransitionRun("preview_ready", "approved"), true);
  assert.equal(canTransitionRun("approved", "running"), true);
  assert.equal(canTransitionRun("running", "paused"), true);
  assert.equal(canTransitionRun("paused", "running"), true);
  assert.equal(canTransitionRun("running", "completed"), true);
  assert.equal(canTransitionRun("approved", "cancelled"), true);

  assert.equal(canTransitionRun("draft", "approved"), false);
  assert.equal(canTransitionRun("preview_ready", "running"), false);
  assert.equal(canTransitionRun("completed", "running"), false);
});

test("write runs require preview_ready before approval", () => {
  assert.equal(canApproveRun({ status: "preview_ready", runKind: "write", approvalRequired: true }), true);
  assert.equal(canApproveRun({ status: "draft", runKind: "write", approvalRequired: true }), false);
  assert.equal(canApproveRun({ status: "preview_ready", runKind: "read", approvalRequired: false }), false);
});

test("claiming starts approved runs and preserves running runs", () => {
  assert.equal(canClaimRun("approved"), true);
  assert.equal(canClaimRun("running"), true);
  assert.equal(canClaimRun("paused"), false);
  assert.equal(statusAfterClaim("approved"), "running");
  assert.equal(statusAfterClaim("running"), "running");
});

test("items claim from pending or stale running only", () => {
  const now = new Date("2026-07-05T12:10:00.000Z");
  const fresh = new Date(now.getTime() - CLAIM_STALE_MS + 1000).toISOString();
  const stale = new Date(now.getTime() - CLAIM_STALE_MS - 1000).toISOString();

  assert.equal(canClaimItem({ status: "pending", attempts: 0, now }), true);
  assert.equal(canClaimItem({ status: "running", attempts: 1, claimedAt: stale, now }), true);
  assert.equal(canClaimItem({ status: "running", attempts: 1, claimedAt: fresh, now }), false);
  assert.equal(canClaimItem({ status: "pending", attempts: 2, now }), false);

  assert.deepEqual(nextItemClaim({ status: "pending", attempts: 0, now }), {
    status: "running",
    attempts: 1,
    claimedAt: now.toISOString()
  });
});

test("items report only from running to terminal item statuses", () => {
  assert.equal(canReportItem("running", "success"), true);
  assert.equal(canReportItem("running", "skipped"), true);
  assert.equal(canReportItem("running", "failed"), true);
  assert.equal(canReportItem("pending", "success"), false);
  assert.equal(canReportItem("running", "needs_review"), false);
});

test("stop rules pause on explicit stop, consecutive failures, or failure rate", () => {
  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["success"],
      doneCount: 1,
      failedCount: 0,
      stopRun: true,
      stopReason: "zoho_logged_out"
    }),
    { pause: true, reason: "zoho_logged_out" }
  );

  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["failed", "failed", "failed"],
      doneCount: 3,
      failedCount: 3
    }),
    { pause: true, reason: "3 consecutive failed items" }
  );

  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["success", "failed"],
      doneCount: 10,
      failedCount: 3
    }),
    { pause: true, reason: "failure rate exceeded 20%" }
  );

  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["success", "failed"],
      doneCount: 9,
      failedCount: 3
    }),
    { pause: false, reason: null }
  );
});

test("run status after report pauses, completes, or keeps running", () => {
  assert.equal(
    statusAfterReport({ currentRunStatus: "running", pendingCount: 2, runningCount: 0, pause: false }),
    "running"
  );
  assert.equal(
    statusAfterReport({ currentRunStatus: "running", pendingCount: 0, runningCount: 0, pause: false }),
    "completed"
  );
  assert.equal(
    statusAfterReport({ currentRunStatus: "running", pendingCount: 2, runningCount: 0, pause: true }),
    "paused"
  );
});
