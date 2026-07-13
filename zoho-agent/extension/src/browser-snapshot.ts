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
