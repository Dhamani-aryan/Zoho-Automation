export type BrowserSnapshotElement = {
  ref: string;
  selector: string;
  alternative_selectors?: string[];
  frame_selector?: string;
  frame_selectors?: string[];
  [key: string]: unknown;
};

export type BrowserSnapshotCache = {
  id: string;
  url: string;
  captured_at: number;
  elements: BrowserSnapshotElement[];
};

export type BrowserSnapshotResolution =
  | { ok: true; snapshot: BrowserSnapshotCache; element: BrowserSnapshotElement }
  | {
      ok: false;
      reason: "missing_snapshot" | "stale_snapshot" | "unknown_ref";
      snapshot?: BrowserSnapshotCache;
    };

export function normalizeBrowserSnapshot(payload: unknown, capturedAt = Date.now()): BrowserSnapshotCache | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as { id?: unknown; url?: unknown; elements?: unknown };
  if (typeof raw.id !== "string" || typeof raw.url !== "string" || !Array.isArray(raw.elements)) return null;
  const elements = raw.elements.filter((element): element is BrowserSnapshotElement => {
    if (!element || typeof element !== "object") return false;
    const item = element as BrowserSnapshotElement;
    return /^@e\d+$/.test(item.ref) && typeof item.selector === "string" && item.selector.length > 0;
  });
  return { id: raw.id, url: raw.url, captured_at: capturedAt, elements };
}

export function resolveBrowserSnapshotElement(options: {
  snapshot: BrowserSnapshotCache | null;
  ref: string;
  currentUrl: string | null;
  now?: number;
  maxAgeMs?: number;
}): BrowserSnapshotResolution {
  const snapshot = options.snapshot;
  if (!snapshot) return { ok: false, reason: "missing_snapshot" };
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 10 * 60 * 1000;
  if (options.currentUrl !== snapshot.url || now - snapshot.captured_at > maxAgeMs) {
    return { ok: false, reason: "stale_snapshot", snapshot };
  }
  const element = snapshot.elements.find((candidate) => candidate.ref === options.ref);
  if (!element) return { ok: false, reason: "unknown_ref", snapshot };
  return { ok: true, snapshot, element };
}

function compactArray(value: unknown, limit: number) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

export function compactBrowserObservation(payload: unknown) {
  if (!payload || typeof payload !== "object") return payload;
  const root = payload as Record<string, unknown>;
  const snapshot = root.snapshot && typeof root.snapshot === "object"
    ? (root.snapshot as Record<string, unknown>)
    : null;
  const elements = compactArray(snapshot?.elements, 35).map((value) => {
    const element = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const compact: Record<string, unknown> = {
      ref: element.ref ?? null,
      role: element.role ?? null,
      name: element.name ?? null,
      tag: element.tag ?? null
    };
    if (element.frame && element.frame !== "main") compact.frame = element.frame;
    if (element.disabled === true) compact.disabled = true;
    if (element.checked !== null && element.checked !== undefined) compact.checked = element.checked;
    if (element.in_viewport === false) compact.in_viewport = false;
    if (element.hidden_until_hover === true) compact.hidden_until_hover = true;
    return compact;
  });
  const controls = compactArray(root.controls, 15).map((value) => {
    const control = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const compact: Record<string, unknown> = {
      tag: control.tag ?? null,
      text: control.text ?? null,
      selector: control.selector ?? null
    };
    if (control.role) compact.role = control.role;
    if (control.value !== undefined) compact.value = control.value;
    if (control.frame_selector) compact.frame_selector = control.frame_selector;
    return compact;
  });
  const targetContext = root.target_context && typeof root.target_context === "object"
    ? (root.target_context as Record<string, unknown>)
    : null;
  // Field order matters: the agent loop hard-truncates tool results by
  // character count, so the highest-value evidence (composer read-back,
  // removable items) must serialize before the long element list.
  return {
    url: root.url ?? null,
    title: root.title ?? null,
    recovery_hint: root.recovery_hint ?? null,
    verification_hint: root.verification_hint ?? null,
    composer: root.composer ?? null,
    schedule_popup: root.schedule_popup ?? null,
    removable_items: compactArray(root.removable_items, 20),
    target_context: targetContext
      ? {
          found: targetContext.found ?? null,
          requested_by: targetContext.requested_by ?? null,
          target: targetContext.target ?? null,
          local_controls: compactArray(targetContext.local_controls, 15),
          guidance: targetContext.guidance ?? null,
          error_message: targetContext.error_message ?? null
        }
      : null,
    snapshot: snapshot
      ? {
          id: snapshot.id ?? null,
          url: snapshot.url ?? root.url ?? null,
          count: snapshot.count ?? elements.length,
          elements
        }
      : null,
    controls,
    headings: compactArray(root.headings, 10),
    warnings: compactArray(root.warnings, 10),
    source_truncated: root.truncated === true
  };
}
