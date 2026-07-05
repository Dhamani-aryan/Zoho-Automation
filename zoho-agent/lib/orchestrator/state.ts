export type RunStatus =
  | "draft"
  | "validating"
  | "preview_ready"
  | "approved"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "canceled";

export type RunItemStatus = "pending" | "running" | "success" | "skipped" | "failed" | "needs_review";

export type ReportableItemStatus = Extract<RunItemStatus, "success" | "skipped" | "failed">;

export const CLAIM_STALE_MS = 5 * 60 * 1000;
export const MAX_ITEM_ATTEMPTS = 2;
export const CONSECUTIVE_FAILURE_LIMIT = 3;
export const FAILURE_RATE_MIN_DONE = 10;
export const FAILURE_RATE_LIMIT = 0.2;

const runTransitions: Record<RunStatus, RunStatus[]> = {
  draft: [],
  validating: [],
  preview_ready: ["approved"],
  approved: ["running", "cancelled", "canceled"],
  running: ["paused", "completed", "failed", "cancelled", "canceled"],
  paused: ["running", "cancelled", "canceled"],
  completed: [],
  failed: [],
  cancelled: [],
  canceled: []
};

export function canTransitionRun(from: RunStatus, to: RunStatus) {
  return runTransitions[from]?.includes(to) ?? false;
}

export function assertRunTransition(from: RunStatus, to: RunStatus) {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}

export function canApproveRun(input: {
  status: RunStatus;
  runKind: "read" | "write";
  approvalRequired: boolean;
}) {
  return input.runKind === "write" && input.approvalRequired && canTransitionRun(input.status, "approved");
}

export function canClaimRun(status: RunStatus) {
  return status === "approved" || status === "running";
}

export function statusAfterClaim(status: RunStatus) {
  if (!canClaimRun(status)) {
    throw new Error(`Run status ${status} cannot be claimed.`);
  }
  return status === "approved" ? "running" : status;
}

export function canClaimItem(input: {
  status: RunItemStatus;
  attempts: number;
  claimedAt?: string | null;
  now?: Date;
}) {
  if (input.attempts >= MAX_ITEM_ATTEMPTS) return false;
  if (input.status === "pending") return true;
  if (input.status !== "running" || !input.claimedAt) return false;

  const claimedAt = Date.parse(input.claimedAt);
  if (Number.isNaN(claimedAt)) return false;
  const now = input.now ?? new Date();
  return now.getTime() - claimedAt > CLAIM_STALE_MS;
}

export function nextItemClaim(input: {
  status: RunItemStatus;
  attempts: number;
  claimedAt?: string | null;
  now?: Date;
}) {
  if (!canClaimItem(input)) {
    throw new Error(`Item with status ${input.status} and ${input.attempts} attempt(s) cannot be claimed.`);
  }

  const now = input.now ?? new Date();
  return {
    status: "running" as const,
    attempts: input.attempts + 1,
    claimedAt: now.toISOString()
  };
}

export function canReportItem(from: RunItemStatus, to: RunItemStatus) {
  return from === "running" && (to === "success" || to === "skipped" || to === "failed");
}

export function assertItemReportTransition(from: RunItemStatus, to: RunItemStatus) {
  if (!canReportItem(from, to)) {
    throw new Error(`Invalid item report transition: ${from} -> ${to}`);
  }
}

export function computeStopDecision(input: {
  recentDoneStatuses: ReportableItemStatus[];
  doneCount: number;
  failedCount: number;
  stopRun?: boolean;
  stopReason?: string | null;
}) {
  if (input.stopRun) {
    return { pause: true, reason: input.stopReason || "extension_requested_stop" };
  }

  const lastThree = input.recentDoneStatuses.slice(-CONSECUTIVE_FAILURE_LIMIT);
  if (
    lastThree.length === CONSECUTIVE_FAILURE_LIMIT &&
    lastThree.every((status) => status === "failed")
  ) {
    return { pause: true, reason: "3 consecutive failed items" };
  }

  if (
    input.doneCount >= FAILURE_RATE_MIN_DONE &&
    input.doneCount > 0 &&
    input.failedCount / input.doneCount > FAILURE_RATE_LIMIT
  ) {
    return { pause: true, reason: "failure rate exceeded 20%" };
  }

  return { pause: false, reason: null };
}

export function statusAfterReport(input: {
  currentRunStatus: RunStatus;
  pendingCount: number;
  runningCount: number;
  pause: boolean;
}) {
  if (input.pause) {
    assertRunTransition(input.currentRunStatus, "paused");
    return "paused" as const;
  }

  if (input.pendingCount === 0 && input.runningCount === 0) {
    assertRunTransition(input.currentRunStatus, "completed");
    return "completed" as const;
  }

  return input.currentRunStatus === "approved" ? "running" : input.currentRunStatus;
}
