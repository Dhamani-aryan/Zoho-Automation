export const APPROVAL_EXPIRY_MS = 15 * 60 * 1000;
export const QUEUED_JOB_EXPIRY_MS = 10 * 60 * 1000;
export const RUNNING_JOB_STALE_MS = 5 * 60 * 1000;

export type SweepCutoffs = {
  nowIso: string;
  pendingApprovalBeforeIso: string;
  queuedJobBeforeIso: string;
  runningJobBeforeIso: string;
};

export function sweepCutoffs(nowMs = Date.now()): SweepCutoffs {
  return {
    nowIso: new Date(nowMs).toISOString(),
    pendingApprovalBeforeIso: new Date(nowMs - APPROVAL_EXPIRY_MS).toISOString(),
    queuedJobBeforeIso: new Date(nowMs - QUEUED_JOB_EXPIRY_MS).toISOString(),
    runningJobBeforeIso: new Date(nowMs - RUNNING_JOB_STALE_MS).toISOString()
  };
}

export function queuedJobExpiryMessage() {
  return "Extension did not claim the job within 10 minutes.";
}

export function runningJobStaleMessage() {
  return "Extension went away mid-job.";
}

export function approvalExpiryPatch(nowIso: string) {
  return { status: "expired", decided_at: nowIso };
}

export function queuedJobExpiryPatch(nowIso: string) {
  return {
    status: "expired",
    completed_at: nowIso,
    error_message: queuedJobExpiryMessage()
  };
}

export function runningJobStalePatch(nowIso: string) {
  return {
    status: "failed",
    completed_at: nowIso,
    error_message: runningJobStaleMessage()
  };
}
