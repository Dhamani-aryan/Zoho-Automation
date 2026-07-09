export const AGENT_APPROVAL_WAIT_MS = 15 * 60 * 1000;

export type TurnClaimDecision =
  | { claimable: true; activeUntilIso: string }
  | { claimable: false; activeUntilIso: string };

export function turnActiveUntil({
  nowMs,
  turnTimeoutMs,
  approvalWaitMs = AGENT_APPROVAL_WAIT_MS
}: {
  nowMs: number;
  turnTimeoutMs: number;
  approvalWaitMs?: number;
}) {
  return new Date(nowMs + turnTimeoutMs + approvalWaitMs).toISOString();
}

export function turnClaimDecision({
  currentActiveUntil,
  nowMs,
  turnTimeoutMs,
  approvalWaitMs = AGENT_APPROVAL_WAIT_MS
}: {
  currentActiveUntil: string | null | undefined;
  nowMs: number;
  turnTimeoutMs: number;
  approvalWaitMs?: number;
}): TurnClaimDecision {
  const activeUntilIso = turnActiveUntil({ nowMs, turnTimeoutMs, approvalWaitMs });
  if (!currentActiveUntil) return { claimable: true, activeUntilIso };

  const activeUntilMs = Date.parse(currentActiveUntil);
  if (!Number.isFinite(activeUntilMs) || activeUntilMs <= nowMs) {
    return { claimable: true, activeUntilIso };
  }

  return { claimable: false, activeUntilIso: currentActiveUntil };
}
