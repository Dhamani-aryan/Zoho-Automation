import type { AgentToolCall } from "@/lib/llm/provider";

export type UiAgilityState = {
  observationFingerprint: string | null;
  refTargets: Record<string, string>;
  actionSinceObservation: boolean;
  lastAction: {
    signature: string;
    beforeFingerprint: string;
  } | null;
};

export type UiActionDecision =
  | { allowed: true; signature: string; beforeFingerprint: string }
  | {
      allowed: false;
      reason: "observation_required" | "verification_required" | "identical_no_change_retry";
      guidance: string;
    };

export function createUiAgilityState(): UiAgilityState {
  return { observationFingerprint: null, refTargets: {}, actionSinceObservation: false, lastAction: null };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactSnapshotElement(value: unknown) {
  const item = asObject(value);
  if (!item) return null;
  return {
    role: item.role ?? null,
    name: item.name ?? null,
    tag: item.tag ?? null,
    selector: item.selector ?? null,
    frame: item.frame ?? null,
    disabled: item.disabled ?? null,
    checked: item.checked ?? null,
    in_viewport: item.in_viewport ?? null
  };
}

export function browserObservationFingerprint(result: unknown) {
  const root = asObject(result) ?? {};
  const snapshot = asObject(root.snapshot);
  const elements = Array.isArray(snapshot?.elements)
    ? snapshot.elements.map(compactSnapshotElement).filter(Boolean)
    : [];
  return JSON.stringify({
    url: root.url ?? null,
    title: root.title ?? null,
    composer: root.composer ?? null,
    headings: root.headings ?? null,
    target_context: root.target_context ?? null,
    elements
  });
}

export function browserActionSignature(
  call: Pick<AgentToolCall, "name" | "args">,
  refTargets: Record<string, string> = {}
) {
  const args = call.args;
  const ref = typeof args.ref === "string" ? args.ref : null;
  return JSON.stringify({
    name: call.name,
    action: args.action ?? null,
    target: ref ? refTargets[ref] ?? ref : null,
    selector: args.selector ?? null,
    text: args.text ?? null,
    value: args.value ?? null,
    key: args.key ?? null,
    repeat: args.repeat ?? null,
    frame_selector: args.frame_selector ?? null
  });
}

export function noteBrowserObservation(state: UiAgilityState, result: unknown) {
  state.observationFingerprint = browserObservationFingerprint(result);
  const root = asObject(result) ?? {};
  const snapshot = asObject(root.snapshot);
  state.refTargets = {};
  if (Array.isArray(snapshot?.elements)) {
    for (const value of snapshot.elements) {
      const element = asObject(value);
      if (typeof element?.ref !== "string") continue;
      state.refTargets[element.ref] = JSON.stringify({
        role: element.role ?? null,
        name: element.name ?? null,
        selector: element.selector ?? null,
        frame: element.frame ?? null
      });
    }
  }
  state.actionSinceObservation = false;
}

export function decideBrowserAction(
  state: UiAgilityState,
  call: AgentToolCall,
  options: { observationVisibleToModel?: boolean } = {}
): UiActionDecision {
  if (!state.observationFingerprint) {
    return {
      allowed: false,
      reason: "observation_required",
      guidance: "Observe the current page first, then choose an element from the returned snapshot based on the user's desired end state."
    };
  }
  if (options.observationVisibleToModel === false) {
    return {
      allowed: false,
      reason: "observation_required",
      guidance:
        "The observation was produced in the same tool batch, so it was not visible when this action was chosen. Review that result and choose the action on the next reasoning step."
    };
  }
  if (state.actionSinceObservation) {
    return {
      allowed: false,
      reason: "verification_required",
      guidance: "Observe the page after the previous action before choosing another action. Use the changed screen, not the old plan."
    };
  }
  const signature = browserActionSignature(call, state.refTargets);
  if (
    state.lastAction?.signature === signature &&
    state.lastAction.beforeFingerprint === state.observationFingerprint
  ) {
    return {
      allowed: false,
      reason: "identical_no_change_retry",
      guidance:
        "The identical action already produced no observable UI change. Re-plan from the current elements and choose a different affordance or interaction method."
    };
  }
  return { allowed: true, signature, beforeFingerprint: state.observationFingerprint };
}

export function noteBrowserAction(state: UiAgilityState, decision: Extract<UiActionDecision, { allowed: true }>) {
  state.lastAction = {
    signature: decision.signature,
    beforeFingerprint: decision.beforeFingerprint
  };
  state.actionSinceObservation = true;
}

export function lastBrowserActionChangedState(state: UiAgilityState): boolean | null {
  if (!state.lastAction || !state.observationFingerprint || state.actionSinceObservation) return null;
  return state.lastAction.beforeFingerprint !== state.observationFingerprint;
}

export function assistantAdmitsUiIncomplete(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return [
    /\bstill (?:not|isn't|is not) (?:done|complete|completed|achieved|correct)\b/,
    /\b(?:requested )?(?:ui )?state (?:is )?(?:still )?not achieved\b/,
    /\b(?:could not|couldn't|unable to|failed to)\b/,
    /\bno change yet\b/,
    /\bremains? (?:in|unchanged|present)\b/,
    /\bnot done\b/
  ].some((pattern) => pattern.test(normalized));
}

export function uiDecisionGuidance(goal: string, state: UiAgilityState) {
  return {
    goal,
    reasoning_contract: [
      "Describe the desired UI state internally.",
      "Choose the visible element whose affordance best advances that state.",
      "Predict the observable change, perform one action, then observe again.",
      "If the predicted change did not occur, choose a different element or interaction method."
    ],
    identical_retry_blocked: Boolean(
      state.lastAction && state.lastAction.beforeFingerprint === state.observationFingerprint
    )
  };
}
