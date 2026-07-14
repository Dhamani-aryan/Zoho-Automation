import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { claimJob, realtimeConfig, reportJobDone, reportJobFailed, streamJob, type JobClaimResponse, type ToolJob } from "./api";
import { zohoPageRunner, type PageResult } from "./page-runner";
import { zohoApiPageRunner } from "./page-runner-api";
import { zohoUiPageRunner } from "./page-runner-ui";
import { zohoWritePageRunner } from "./page-runner-write";
import { SEND_NOW_BLOCKED_MESSAGE, isModifierEnterKey, isPlainEnterKey, looksLikeSendNowEndpoint } from "./send-guard";
import { loadSettings, saveLastJobStatus } from "./storage";
import {
  compactBrowserObservation,
  normalizeBrowserSnapshot,
  resolveBrowserSnapshotElement,
  type BrowserSnapshotCache
} from "./browser-snapshot";

// Tier-2 write tools. Kept in sync with lib/agent/tier2-tools.ts
// TIER2_WRITE_TOOL_NAMES; the lib-side extensionAcceptsWriteJob() encodes the
// same rule and is unit-tested.
const WRITE_TOOLS = new Set([
  "zoho_update_fields",
  "zoho_change_owner",
  "zoho_add_tags",
  "zoho_remove_tags",
  "schedule_zoho_email"
]);

const ACTIVE_POLL_MS = 30000;
const IDLE_POLL_MS = 60000;
const IDLE_BACKOFF_AFTER_MS = 5 * 60 * 1000;
const REALTIME_RECONNECT_MS = 5000;
const STREAM_RECONNECT_MS = 1000;
const STREAM_TIMEOUT_MS = 70000;
const AGENT_WINDOW_HOME = "https://crm.zoho.com/crm/org890324941/tab/Potentials/custom-view/6834250000000087545/list";
const AGENT_WINDOW_KEYS = {
  agentWindowId: null as number | null,
  agentTabId: null as number | null,
  agentWindowDedicated: false
};

let inFlight = false;
let streamInFlight = false;
let realtimeStarting = false;
let idleSince = Date.now();
let timer: number | undefined;
let streamTimer: number | undefined;
let realtimeTimer: number | undefined;
let realtimeClient: SupabaseClient | null = null;
let realtimeChannel: RealtimeChannel | null = null;

const browserSnapshotCache = new Map<number, BrowserSnapshotCache>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotStorageKey(tabId: number) {
  return `browser_snapshot_${tabId}`;
}

async function cacheBrowserSnapshot(tabId: number, payload: unknown) {
  if (!payload || typeof payload !== "object") return;
  const snapshot = (payload as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== "object") return;
  const cached = normalizeBrowserSnapshot(snapshot);
  if (!cached) return;
  browserSnapshotCache.set(tabId, cached);
  await chrome.storage.local.set({ [snapshotStorageKey(tabId)]: cached });
}

async function readBrowserSnapshot(tabId: number) {
  const memory = browserSnapshotCache.get(tabId);
  if (memory) return memory;
  const key = snapshotStorageKey(tabId);
  const stored = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get({ [key]: null }, (items) => resolve(items));
  });
  const snapshot = stored[key] as BrowserSnapshotCache | undefined;
  if (snapshot?.id && snapshot.url && Array.isArray(snapshot.elements)) {
    browserSnapshotCache.set(tabId, snapshot);
    return snapshot;
  }
  return null;
}

async function resolveBrowserSnapshotRef(
  tabId: number,
  args: Record<string, unknown>
): Promise<{ ok: true; target: Record<string, unknown> } | { ok: false; response: PageResult }> {
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";
  if (!ref) return { ok: true, target: args };
  if (!/^@e\d+$/.test(ref)) {
    return { ok: false, response: { ok: false, error_message: `Invalid browser element ref: ${ref}` } };
  }
  const snapshot = await readBrowserSnapshot(tabId);
  if (!snapshot) {
    return {
      ok: false,
      response: { ok: false, error_message: `No browser snapshot is available for ${ref}. Run browser_observe again.` }
    };
  }
  const tab = await chrome.tabs.get(tabId);
  const resolution = resolveBrowserSnapshotElement({ snapshot, ref, currentUrl: tab.url ?? null });
  if (!resolution.ok && resolution.reason === "stale_snapshot") {
    return {
      ok: false,
      response: {
        ok: false,
        error_message: `Browser snapshot ${snapshot.id} is stale for ${ref}. Run browser_observe again.`,
        result: { stale_ref: true, ref, snapshot_url: snapshot.url, current_url: tab.url ?? null }
      }
    };
  }
  if (!resolution.ok) {
    return {
      ok: false,
      response: {
        ok: false,
        error_message:
          resolution.reason === "missing_snapshot"
            ? `No browser snapshot is available for ${ref}. Run browser_observe again.`
            : `Unknown browser element ref ${ref}. Run browser_observe again.`
      }
    };
  }
  const element = resolution.element;
  return {
    ok: true,
    target: {
      ...args,
      selector: element.selector,
      alternative_selectors: element.alternative_selectors ?? [],
      ...(element.frame_selector ? { frame_selector: element.frame_selector } : {}),
      ...(element.frame_selectors ? { frame_selectors: element.frame_selectors } : {}),
      ...(element.hidden_until_hover === true ? { hidden_until_hover: true } : {}),
      ...(typeof element.container_selector === "string" && element.container_selector
        ? { container_selector: element.container_selector }
        : {}),
      snapshot_id: snapshot.id,
      ref
    }
  };
}

function debuggerApi() {
  return (chrome as unknown as { "debugger": chrome.DebuggerApi })["debugger"];
}

function crmTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "https://crm.zoho.com/*" }, resolve);
  });
}

function storedAgentTarget(): Promise<{
  agentWindowId: number | null;
  agentTabId: number | null;
  agentWindowDedicated: boolean;
}> {
  return new Promise((resolve) => {
    chrome.storage.local.get(AGENT_WINDOW_KEYS, (items) => {
      resolve({
        agentWindowId: typeof items.agentWindowId === "number" ? items.agentWindowId : null,
        agentTabId: typeof items.agentTabId === "number" ? items.agentTabId : null,
        agentWindowDedicated: items.agentWindowDedicated === true
      });
    });
  });
}

function saveAgentTarget(
  agentWindowId: number | null,
  agentTabId: number | null,
  agentWindowDedicated: boolean
): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ agentWindowId, agentTabId, agentWindowDedicated }, resolve);
  });
}

function isCrmUrl(url: unknown) {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).hostname === "crm.zoho.com";
  } catch {
    return false;
  }
}

function initialUrlForJob(job: ToolJob) {
  if (job.tool_name === "schedule_zoho_email" && isCrmUrl(job.args.deal_url)) {
    return String(job.args.deal_url);
  }
  if (job.tool_name === "ui_step") {
    const step = (job.args.step ?? {}) as Record<string, unknown>;
    if (step.type === "open_url" && isCrmUrl(step.url)) return String(step.url);
  }
  if (job.tool_name === "ui_workflow") {
    const steps = Array.isArray(job.args.steps) ? (job.args.steps as Array<Record<string, unknown>>) : [];
    const firstOpen = steps.find((step) => step?.type === "open_url" && isCrmUrl(step.url));
    if (firstOpen) return String(firstOpen.url);
  }
  if (job.tool_name === "browser_navigate" && isCrmUrl(job.args.url)) {
    return String(job.args.url);
  }
  return AGENT_WINDOW_HOME;
}

async function usableStoredTab(requireDedicated: boolean) {
  const stored = await storedAgentTarget();
  if (typeof stored.agentTabId !== "number") return null;
  if (requireDedicated && !stored.agentWindowDedicated) return null;
  try {
    const tab = await chrome.tabs.get(stored.agentTabId);
    if (typeof tab.id === "number" && isCrmUrl(tab.url)) return tab;
  } catch {
    // The user may have closed the dedicated window; create a fresh one below.
  }
  await saveAgentTarget(null, null, false);
  return null;
}

async function createAgentWindow(url: string) {
  const createData = {
    url,
    focused: false,
    type: "normal",
    width: 1440,
    height: 2000,
    left: 0,
    top: 0
  } as unknown as Parameters<typeof chrome.windows.create>[0];
  const created = await chrome.windows.create(createData);
  const tab = created.tabs?.find((item) => typeof item.id === "number") ?? null;
  const tabId = tab?.id ?? null;
  await saveAgentTarget(created.id ?? null, tabId, true);
  if (tabId) await waitForTabComplete(tabId);
  return tabId ? await chrome.tabs.get(tabId) : null;
}

// Browser jobs use a dedicated tab so they never drive a CRM tab the user is
// actively working in. The dedicated window stays unfocused; script injection
// and CDP target its tab id directly and do not need the OS cursor or foreground.
function requiresDedicatedAgentWindow(job: ToolJob) {
  return (
    job.tool_name === "ui_step" ||
    job.tool_name === "ui_workflow" ||
    job.tool_name === "browser_observe" ||
    job.tool_name === "browser_navigate" ||
    job.tool_name === "browser_screenshot" ||
    job.tool_name === "browser_input" ||
    job.tool_name === "browser_eval" ||
    job.tool_name === "schedule_zoho_email"
  );
}

async function browserEvalPageRunner(job: { args: Record<string, unknown> }) {
  const code = typeof job.args.code === "string" ? job.args.code : "";
  const awaitPromise = job.args.await_promise === true;
  const frameSelector = typeof job.args.frame_selector === "string" ? job.args.frame_selector.trim() : "";
  let signatureRemoved = false;
  let signatureRestored = false;
  let sendNowBlocked = false;
  if (!code.trim()) return { ok: false, error_message: "browser_eval code is empty." };
  try {
    const SEND_NOW_BLOCKED_MESSAGE = "send-now is blocked; schedule instead";
    function looksLikeSendNowEndpoint(value: string) {
      return [/\/actions\/[^/?#]*send/i, /\/send(?:mail|_mail|now|_now)?\b/i].some((pattern) => pattern.test(value));
    }
    function normalizedLabel(value: unknown) {
      return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }
    function controlInfo(element: Element) {
      const el = element as HTMLInputElement;
      return {
        text: element.textContent ?? "",
        value: el.value ?? "",
        ariaLabel: element.getAttribute("aria-label") ?? "",
        title: element.getAttribute("title") ?? "",
        role: element.getAttribute("role") ?? ""
      };
    }
    function accessibleNames(element: Element) {
      const info = controlInfo(element);
      return [info.ariaLabel, info.value, info.title, info.text].map(normalizedLabel).filter(Boolean);
    }
    function isScheduleControl(element: Element) {
      return accessibleNames(element).some((name) => name === "schedule" || name === "schedule & close");
    }
    function isSendNowControl(element: Element) {
      if (isScheduleControl(element)) return false;
      const role = normalizedLabel(element.getAttribute("role") ?? "");
      const buttonish = !role || role === "button" || role === "menuitem" || role === "link";
      if (!buttonish) return false;
      return accessibleNames(element).some((name) => name === "send" || name === "send email" || name === "send now" || name === "send mail");
    }
    function rootHasComposerSignature(root: Element) {
      if (root.querySelector("#ecw_signature")) return true;
      for (const iframe of root.querySelectorAll("iframe")) {
        try {
          if (iframe instanceof HTMLIFrameElement && iframe.contentDocument?.querySelector("#ecw_signature")) return true;
        } catch {
          // Cross-origin frames are not part of the same-origin Zoho composer surface.
        }
      }
      return false;
    }
    function rootHasComposerRecipients(root: Element) {
      return Boolean(root.querySelector("[id^='ceToAddr_'],[id^='ceCCAddr_'],[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']"));
    }
    function isInsideComposerSurface(element: Element) {
      const directComposerElement = element.closest(
        "[id^='ceSubject_'],[id^='ceToAddr_'],[id^='ceCCAddr_'],#editorDiv,#ecw_signature,#z_editor,[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']"
      );
      if (directComposerElement) return true;
      const composerRootSelector =
        "[role='dialog'],[aria-modal='true'],.lyteModal,.lytePopup,.modal,.zc-modal,.crm-popup,.popup-model-content,[class*='compose'],[class*='Compose'],[id*='compose'],[id*='Compose']";
      for (let root = element.closest(composerRootSelector); root; root = root.parentElement?.closest(composerRootSelector) ?? null) {
        if (rootHasComposerRecipients(root) && rootHasComposerSignature(root)) return true;
      }
      return false;
    }
    function isSendNowElement(target: EventTarget | null) {
      if (!(target instanceof Element)) return false;
      const candidate = target.closest("button,a,input,[role='button'],span,div");
      if (!candidate) return false;
      return isInsideComposerSurface(candidate) && isSendNowControl(candidate);
    }
    function activeElementIsSendNow(doc: Document) {
      const active = doc.activeElement;
      return active instanceof Element && isSendNowElement(active);
    }
    // Zoho renders the email composer body (and some dialogs) inside a
    // same-origin iframe. When a frame_selector is given, resolve that frame's
    // document and bind it to `document` inside the evaluated code so the
    // model's DOM queries target the composer, not the top page. Same-origin
    // access works directly from the top MAIN world - no frame injection.
    let boundDocument: Document = document;
    if (frameSelector) {
      const frame = document.querySelector(frameSelector);
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) {
        return { ok: false, error_message: `browser_eval frame_selector matched no accessible iframe: ${frameSelector}` };
      }
      boundDocument = frame.contentDocument;
    }
    function findSignatureDocument(root: Document): Document | null {
      if (root.querySelector("#ecw_signature")) return root;
      for (const iframe of root.querySelectorAll("iframe")) {
        try {
          const child = iframe.contentDocument;
          if (!child) continue;
          const found = findSignatureDocument(child);
          if (found) return found;
        } catch {
          // Cross-origin frames are outside the Zoho composer and inaccessible.
        }
      }
      return null;
    }
    const signatureDocument = findSignatureDocument(document) ?? boundDocument;
    const signature = signatureDocument.querySelector("#ecw_signature");
    const signatureBackup = signature ? (signature.cloneNode(true) as Element) : null;
    const signatureParent = signature?.parentElement ?? null;
    const signatureNextSibling = signature?.nextSibling ?? null;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (looksLikeSendNowEndpoint(url)) {
        sendNowBlocked = true;
        return Promise.reject(new Error(SEND_NOW_BLOCKED_MESSAGE));
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    const clickGuard = (event: Event) => {
      if (!isSendNowElement(event.target)) return;
      sendNowBlocked = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keyGuard = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (!activeElementIsSendNow(event.currentTarget instanceof Document ? event.currentTarget : document)) return;
      sendNowBlocked = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", clickGuard, true);
    document.addEventListener("keydown", keyGuard, true);
    if (boundDocument !== document) boundDocument.addEventListener("click", clickGuard, true);
    if (boundDocument !== document) boundDocument.addEventListener("keydown", keyGuard, true);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    // `document` is shadowed by the bound (possibly frame) document; `window`
    // and `window.document` stay top-level so callers can still read #token.
    const fn = awaitPromise ? new AsyncFunction("document", code) : new Function("document", code);
    let raw: unknown;
    try {
      raw = awaitPromise ? await fn(boundDocument) : fn(boundDocument);
    } finally {
      window.fetch = originalFetch;
      document.removeEventListener("click", clickGuard, true);
      document.removeEventListener("keydown", keyGuard, true);
      if (boundDocument !== document) boundDocument.removeEventListener("click", clickGuard, true);
      if (boundDocument !== document) boundDocument.removeEventListener("keydown", keyGuard, true);
      if (signatureBackup && !signatureDocument.querySelector("#ecw_signature")) {
        signatureRemoved = true;
        const restoreParent = signatureParent?.isConnected
          ? signatureParent
          : signatureDocument.querySelector("#editorDiv");
        if (restoreParent) {
          if (signatureNextSibling?.parentNode === restoreParent) {
            restoreParent.insertBefore(signatureBackup, signatureNextSibling);
          } else {
            restoreParent.appendChild(signatureBackup);
          }
          signatureRestored = true;
        }
      }
    }
    if (signatureRemoved) {
      return {
        ok: false,
        error_message: signatureRestored
          ? "browser_eval attempted to remove the existing Zoho email signature; the extension restored it. Insert body content before #ecw_signature and verify by read-back."
          : "browser_eval removed the existing Zoho email signature and the extension could not restore it. Stop and reopen a fresh composer.",
        result: { signature_removed: true, signature_restored: signatureRestored }
      };
    }
    if (sendNowBlocked) {
      return { ok: false, error_message: SEND_NOW_BLOCKED_MESSAGE, result: { send_now_blocked: true } };
    }
    if (raw === undefined) {
      return {
        ok: true,
        result: {
          executed: true,
          returned: false,
          possible_state_change: true,
          verification_required: true,
          warning:
            "browser_eval completed without a return value. Do not treat null as proof that nothing changed; observe and read back the page before retrying or reporting."
        }
      };
    }
    const json = JSON.stringify(raw ?? null);
    if (json.length > 64 * 1024) {
      return {
        ok: true,
        result: {
          truncated: true,
          original_char_count: json.length,
          preview: json.slice(0, 64 * 1024)
        }
      };
    }
    return { ok: true, result: JSON.parse(json) };
  } catch (error) {
    if (sendNowBlocked) {
      return { ok: false, error_message: "send-now is blocked; schedule instead", result: { send_now_blocked: true } };
    }
    return {
      ok: false,
      error_message: error instanceof Error ? error.message : "browser_eval failed."
    };
  }
}

function browserObservePageRunner(input?: {
  args?: { scope_selector?: string; target_selector?: string; target_text?: string };
}) {
  const LIMIT = 16 * 1024;
  const scopeSelector = typeof input?.args?.scope_selector === "string" ? input.args.scope_selector.trim() : "";
  const targetSelector = typeof input?.args?.target_selector === "string" ? input.args.target_selector.trim() : "";
  const targetText = typeof input?.args?.target_text === "string" ? input.args.target_text.trim() : "";

  type ObserveContext = {
    doc: Document;
    root: ParentNode;
    frame: string;
    frameSelector: string | null;
    frameSelectors: string[];
    offsetX: number;
    offsetY: number;
  };

  function isVisible(element: Element) {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView ?? window;
    const style = view.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function textOf(element: Element) {
    return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function valueOf(element: Element, maxLength = 1000): string | null {
    if (element instanceof HTMLInputElement) {
      if (element.type.toLowerCase() === "password") return null;
      if (element.type === "checkbox" || element.type === "radio") return element.checked ? "checked" : "unchecked";
      return element.value.slice(0, maxLength);
    }
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return element.value.slice(0, maxLength);
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return (element.innerText || element.textContent || "").replace(/\r/g, "").trim().slice(0, maxLength);
    }
    return null;
  }

  function selectorFor(element: Element) {
    const el = element as HTMLElement;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const doc = element.ownerDocument;
    const tag = element.tagName.toLowerCase();
    for (const attribute of ["data-testid", "data-test", "data-qa", "name", "aria-label", "title", "role"]) {
      const value = el.getAttribute(attribute);
      if (!value) continue;
      const candidate = `${tag}[${attribute}="${CSS.escape(value)}"]`;
      try {
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // Fall through to a structural selector.
      }
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== doc.documentElement && parts.length < 5) {
      const currentTag = current.tagName.toLowerCase();
      const classes = Array.from(current.classList)
        .filter((name) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))
        .slice(0, 2);
      let part = currentTag + classes.map((name) => `.${CSS.escape(name)}`).join("");
      const parentElement: Element | null = current.parentElement;
      if (parentElement) {
        const currentTagName = current.tagName;
        const sameTag = Array.from(parentElement.children).filter((child: Element) => child.tagName === currentTagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try {
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // Keep adding ancestry.
      }
      current = parentElement;
    }
    return parts.join(" > ") || tag;
  }

  function dialogSelectorFor(element: Element) {
    const dialog = element.closest("dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,.lyteModal,.lyteModalContent");
    if (dialog) return selectorFor(dialog);
    let parent = element.parentElement;
    while (parent) {
      const classes = String(parent.getAttribute("class") ?? "").toLowerCase();
      if (classes.includes("modal") || classes.includes("popup") || classes.includes("overlay")) return selectorFor(parent);
      parent = parent.parentElement;
    }
    return null;
  }

  function iframeContext(iframe: HTMLIFrameElement, parent: ObserveContext): ObserveContext | null {
    try {
      const childDoc = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
      if (!childDoc?.body) return null;
      const rect = iframe.getBoundingClientRect();
      const frameSelector = selectorFor(iframe);
      const frame = parent.frame === "main" ? frameSelector : `${parent.frame} ${frameSelector}`;
      return {
        doc: childDoc,
        root: childDoc,
        frame,
        frameSelector,
        frameSelectors: [...parent.frameSelectors, frameSelector],
        offsetX: parent.offsetX + rect.left,
        offsetY: parent.offsetY + rect.top
      };
    } catch {
      return null;
    }
  }

  function collectContexts() {
    const contexts: ObserveContext[] = [
      { doc: document, root: document, frame: "main", frameSelector: null, frameSelectors: [], offsetX: 0, offsetY: 0 }
    ];
    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      const iframes = Array.from(context.root.querySelectorAll?.("iframe") ?? []) as HTMLIFrameElement[];
      for (const iframe of iframes) {
        if (!isVisible(iframe)) continue;
        const child = iframeContext(iframe, context);
        if (child) contexts.push(child);
      }
    }
    return contexts;
  }

  function scopedContexts(contexts: ObserveContext[]) {
    if (!scopeSelector) return { contexts, warnings: [] as string[] };
    const warnings: string[] = [];
    const scoped: ObserveContext[] = [];
    for (const context of contexts) {
      let matches: Element[] = [];
      try {
        matches = Array.from(context.root.querySelectorAll?.(scopeSelector) ?? []);
      } catch {
        return { contexts: [] as ObserveContext[], warnings: [`Invalid scope_selector: ${scopeSelector}`] };
      }
      for (const match of matches) {
        if (!isVisible(match)) continue;
        if (match.tagName.toLowerCase() === "iframe") {
          const child = iframeContext(match as HTMLIFrameElement, context);
          if (child) scoped.push(child);
          else warnings.push(`scope_selector matched iframe ${selectorFor(match)} but it was not same-origin/readable`);
          continue;
        }
        scoped.push({ ...context, root: match });
      }
    }
    if (scoped.length === 0) warnings.push(`No visible matches for scope_selector: ${scopeSelector}`);
    return { contexts: scoped, warnings };
  }

  const allContexts = collectContexts();
  const scoped = scopedContexts(allContexts);
  if (scopeSelector && scoped.contexts.length === 0) {
    return { ok: false, error_message: scoped.warnings.join("; ") || `No visible matches for ${scopeSelector}.` };
  }

  function inspectDescriptor(element: Element, context: ObserveContext, relation: string) {
    const el = element as HTMLElement;
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView ?? window;
    const style = view.getComputedStyle(element);
    const pseudoText = ["::before", "::after"]
      .map((pseudo) => view.getComputedStyle(element, pseudo).content)
      .filter((content) => content && content !== "none" && content !== "normal" && content !== '""')
      .map((content) => content.replace(/^['"]|['"]$/g, ""))
      .join(" ")
      .slice(0, 80);
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const actionText = [
      directText,
      pseudoText,
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
      el.getAttribute("class") ?? ""
    ]
      .join(" ")
      .toLowerCase();
    const semanticClickable =
      element.matches("button,a,input,[role='button'],[role='menuitem'],[tabindex]") ||
      typeof (el as HTMLElement & { onclick?: unknown }).onclick === "function" ||
      style.cursor === "pointer";
    const symbolAffordance = /(^|\s)(x|\u00d7|\u2715|\u2716|close|remove|dismiss|clear|delete)(\s|$)/i.test(actionText);
    return {
      relation,
      tag: element.tagName.toLowerCase(),
      text: textOf(element),
      direct_text: directText,
      selector: selectorFor(element),
      role: el.getAttribute("role") ?? "",
      aria_label: el.getAttribute("aria-label") ?? "",
      title: el.getAttribute("title") ?? "",
      pseudo_text: pseudoText,
      cursor: style.cursor,
      tabindex: el.getAttribute("tabindex"),
      clickable: semanticClickable,
      likely_actionable: semanticClickable || symbolAffordance,
      frame: context.frame,
      ...(context.frameSelector ? { frame_selector: context.frameSelector } : {}),
      rect: {
        x: Math.round(context.offsetX + rect.left),
        y: Math.round(context.offsetY + rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function targetInspection(contexts: ObserveContext[]) {
    if (!targetSelector && !targetText) return null;
    const matches: Array<{ element: Element; context: ObserveContext }> = [];
    for (const context of contexts) {
      let candidates: Element[] = [];
      if (targetSelector) {
        try {
          candidates = Array.from(context.root.querySelectorAll?.(targetSelector) ?? []);
          if (context.root instanceof Element && context.root.matches(targetSelector)) candidates.unshift(context.root);
        } catch {
          return { found: false, error_message: `Invalid target_selector: ${targetSelector}` };
        }
      } else {
        const wanted = targetText.toLowerCase();
        candidates = Array.from(context.root.querySelectorAll?.("*") ?? [])
          .filter(isVisible)
          .filter((element) => {
            const ownText = textOf(element).toLowerCase();
            const accessible = [
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
              element.getAttribute("placeholder")
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return ownText === wanted || accessible.includes(wanted);
          })
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
          });
      }
      for (const element of candidates.filter(isVisible)) matches.push({ element, context });
    }
    const match = matches[0];
    if (!match) {
      return {
        found: false,
        error_message: targetSelector
          ? `No visible element matched target_selector: ${targetSelector}`
          : `No visible element exactly matched target_text: ${targetText}`
      };
    }

    const { element: target, context } = match;
    const candidates: Array<{ element: Element; relation: string }> = [];
    for (const descendant of Array.from(target.querySelectorAll("*"))) {
      if (isVisible(descendant)) candidates.push({ element: descendant, relation: "descendant" });
    }
    for (const sibling of [target.previousElementSibling, target.nextElementSibling]) {
      if (sibling && isVisible(sibling)) candidates.push({ element: sibling, relation: "sibling" });
    }
    const parent = target.parentElement;
    if (parent) {
      for (const element of Array.from(parent.querySelectorAll("*"))) {
        if (element !== target && !target.contains(element) && isVisible(element)) {
          candidates.push({ element, relation: "nearby" });
        }
      }
    }
    const rect = target.getBoundingClientRect();
    const samplePoints = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.right - Math.min(8, rect.width / 4), rect.top + rect.height / 2],
      [rect.left + Math.min(8, rect.width / 4), rect.top + rect.height / 2]
    ];
    for (const [x, y] of samplePoints) {
      for (const hit of context.doc.elementsFromPoint(x, y)) {
        if (isVisible(hit)) candidates.push({ element: hit, relation: "hit_target" });
      }
    }
    const seen = new Set<Element>();
    const local_controls = candidates
      .filter(({ element }) => {
        if (seen.has(element)) return false;
        seen.add(element);
        return true;
      })
      .map(({ element, relation }) => inspectDescriptor(element, context, relation))
      .sort(
        (left, right) =>
          Number(right.likely_actionable) - Number(left.likely_actionable) ||
          Number(right.clickable) - Number(left.clickable)
      )
      .slice(0, 60);
    return {
      found: true,
      requested_by: targetSelector ? { selector: targetSelector } : { text: targetText },
      target: inspectDescriptor(target, context, "target"),
      local_controls,
      guidance:
        "Choose a visible clickable descendant or nearby control from this fresh evidence. After acting, observe the target again to verify the requested state."
    };
  }

  const target_context = targetInspection(scoped.contexts);

  const headings = scoped.contexts
    .flatMap((context) =>
      Array.from(context.root.querySelectorAll?.("h1,h2,h3,[role='heading']") ?? [])
        .filter(isVisible)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: textOf(element),
          frame: context.frame,
          ...(context.frameSelector ? { frame_selector: context.frameSelector } : {}),
          ...(dialogSelectorFor(element) ? { dialog_selector: dialogSelectorFor(element) } : {})
        }))
    )
    .slice(0, 60)
    .filter((item) => item.text);

  const controls = scoped.contexts
    .flatMap((context) =>
      Array.from(
        context.root.querySelectorAll?.(
          "button,a,input,textarea,select,[role='button'],[role='menuitem'],[contenteditable='true'],[id^='ceToAddrDetails'] li.selectedEmail,[id^='ceCCAddrDetails'] li.selectedEmail,#ecw_signature"
        ) ?? []
      )
        .filter(isVisible)
        .map((element) => {
          const el = element as HTMLElement;
          const rect = element.getBoundingClientRect();
          const dialogSelector = dialogSelectorFor(element);
          const value = valueOf(element);
          const composerEvidence = element.matches(
            "[id^='ceToAddr_'],[id^='ceCCAddr_'],[id^='ceSubject_'],#editorDiv,#ecw_signature,[id^='ceToAddrDetails'] li.selectedEmail,[id^='ceCCAddrDetails'] li.selectedEmail"
          );
          return {
            tag: element.tagName.toLowerCase(),
            role: el.getAttribute("role") ?? "",
            text:
              textOf(element) ||
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("title") ||
              "",
            ...(value !== null ? { value } : {}),
            selector: selectorFor(element),
            frame: context.frame,
            ...(context.frameSelector ? { frame_selector: context.frameSelector } : {}),
            ...(dialogSelector ? { dialog_selector: dialogSelector } : {}),
            x: Math.round(context.offsetX + rect.left + rect.width / 2),
            y: Math.round(context.offsetY + rect.top + rect.height / 2),
            _priority:
              (composerEvidence ? 20 : 0) +
              (value !== null ? 8 : 0) +
              (context.frameSelector ? 5 : 0) +
              (dialogSelector ? 3 : 0)
          };
        })
    )
    .sort((a, b) => b._priority - a._priority)
    .slice(0, 160)
    .filter((item) => item.text || item.selector)
    .map(({ _priority, ...item }) => item);

  function implicitRole(element: Element) {
    const explicit = element.getAttribute("role")?.trim().toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea" || (element instanceof HTMLElement && element.isContentEditable)) return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    const el = element as HTMLElement;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (element.hasAttribute("onclick") || typeof el.onclick === "function" || style?.cursor === "pointer") return "clickable";
    if (el.tabIndex >= 0) return "focusable";
    return "generic";
  }

  function accessibleName(element: Element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
          .join(" ")
      : "";
    const input = element as HTMLInputElement;
    const labels = "labels" in input && input.labels
      ? Array.from(input.labels).map((label) => label.textContent ?? "").join(" ")
      : "";
    return [
      element.getAttribute("aria-label"),
      labelledText,
      labels,
      element.getAttribute("alt"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      input.value && ["button", "submit", "reset"].includes((input.type || "").toLowerCase()) ? input.value : "",
      textOf(element)
    ]
      .find((value) => typeof value === "string" && value.trim())
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) ?? "";
  }

  function selectorCandidatesFor(element: Element) {
    const doc = element.ownerDocument;
    const tag = element.tagName.toLowerCase();
    const candidates: string[] = [];
    const add = (candidate: string) => {
      try {
        if (doc.querySelectorAll(candidate).length === 1 && !candidates.includes(candidate)) candidates.push(candidate);
      } catch {
        // Ignore selectors containing values the browser cannot parse.
      }
    };
    if ((element as HTMLElement).id) add(`#${CSS.escape((element as HTMLElement).id)}`);
    for (const attribute of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "name", "aria-label", "placeholder", "title"]) {
      const value = element.getAttribute(attribute);
      if (value) add(`${tag}[${attribute}="${CSS.escape(value)}"]`);
    }
    if (tag === "a" && element.getAttribute("href")) add(`${tag}[href="${CSS.escape(element.getAttribute("href") ?? "")}"]`);
    add(selectorFor(element));
    return candidates;
  }

  function actionableElementFor(element: Element, role: string) {
    const selectorByRole: Record<string, string> = {
      button: "button,summary,[role='button']",
      link: "a[href]",
      textbox: "input:not([type='hidden']),textarea,[role='textbox'],[contenteditable='true']",
      searchbox: "input[type='search'],[role='searchbox']",
      combobox: "select,[role='combobox'],[role='listbox']",
      checkbox: "input[type='checkbox'],[role='checkbox']",
      radio: "input[type='radio'],[role='radio']"
    };
    const selector = selectorByRole[role];
    if (!selector) return element;
    if (element.matches(selector) && isVisible(element)) return element;
    const descendant = Array.from(element.querySelectorAll(selector)).find(isVisible);
    if (descendant) return descendant;
    const ancestor = element.closest(selector);
    return ancestor && isVisible(ancestor) ? ancestor : element;
  }

  const snapshotCandidates = scoped.contexts.flatMap((context) =>
    Array.from(context.root.querySelectorAll?.("*") ?? [])
      .filter(isVisible)
      .map((source) => {
        const sourceRole = implicitRole(source);
        const directText = Array.from(source.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const symbolControl = /^(x|\u00d7|\u2715|\u2716)$/i.test(directText) ||
          /(^|[-_])(close|remove|dismiss|clear|delete)([-_]|$)/i.test(source.getAttribute("class") ?? "");
        // Cc/Bcc reveal links are plain spans/divs; keep them even when no
        // implicit role or pointer cursor marks them as interactive.
        const revealControl = /^(cc|bcc)$/i.test(directText);
        if (sourceRole === "generic" && !symbolControl && !revealControl) return null;
        const target = actionableElementFor(source, sourceRole);
        const role = implicitRole(target) === "generic" ? sourceRole : implicitRole(target);
        const snapshotRole = (symbolControl || revealControl) && role === "generic" ? "clickable" : role;
        const selectors = selectorCandidatesFor(target);
        if (selectors.length === 0) return null;
        const rect = target.getBoundingClientRect();
        const view = target.ownerDocument.defaultView ?? window;
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
        const name = accessibleName(source) || accessibleName(target) || directText;
        const activeSurface = Boolean(
          source.closest("dialog,[role='dialog'],[aria-modal='true'],[class*='modal' i],[class*='popup' i],[class*='compose' i]")
        );
        // Composer chrome (recipient inputs, chips, subject, Cc/Bcc reveal
        // links) must outrank the composer toolbar buttons so they survive
        // the compact snapshot cap.
        const composerChromeSelector =
          "[id^='ceToAddr_'],[id^='ceCCAddr_'],[id^='ceSubject_'],[id^='ceToAddrDetails'] li.selectedEmail,[id^='ceCCAddrDetails'] li.selectedEmail";
        const composerChrome =
          source.matches(composerChromeSelector) ||
          target.matches(composerChromeSelector) ||
          Boolean(source.closest("[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']")) ||
          (revealControl && activeSurface);
        return {
          role: snapshotRole,
          name,
          tag: target.tagName.toLowerCase(),
          selector: selectors[0],
          alternative_selectors: selectors.slice(1, 5),
          frame: context.frame,
          ...(context.frameSelector ? { frame_selector: context.frameSelector } : {}),
          ...(context.frameSelectors.length > 1 ? { frame_selectors: context.frameSelectors } : {}),
          disabled: (target as HTMLInputElement).disabled === true || target.getAttribute("aria-disabled") === "true",
          checked:
            role === "checkbox" || role === "radio" || role === "switch"
              ? (target as HTMLInputElement).checked === true || target.getAttribute("aria-checked") === "true"
              : null,
          in_viewport: inViewport,
          x: Math.round(context.offsetX + rect.left + rect.width / 2),
          y: Math.round(context.offsetY + rect.top + rect.height / 2),
          _priority:
            (inViewport ? 100 : 0) +
            (activeSurface ? 100 : 0) +
            (composerChrome ? 150 : 0) +
            ({ button: 80, link: 70, textbox: 75, searchbox: 75, combobox: 75, checkbox: 65, radio: 65, clickable: 60, focusable: 40 }[snapshotRole] ?? 20) +
            (name ? 10 : 0)
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
  );
  // Chip/token remove controls that are hidden until hover never pass the
  // isVisible filter above, so the model would otherwise get no ref for them.
  // Surface them explicitly with hidden_until_hover=true plus the visible
  // chip container; browser_input routes such refs through the hover-first
  // remove flow.
  const hiddenRemoveCandidates = scoped.contexts.flatMap((context) =>
    Array.from(
      context.root.querySelectorAll?.(
        "li.selectedEmail,[role='option'],[role='listitem'],[class*='chip' i],[class*='tag' i],[class*='pill' i],[class*='token' i]"
      ) ?? []
    )
      .filter(isVisible)
      .map((item) => {
        const remove = item.querySelector(
          "[aria-label*='remove' i],[aria-label*='close' i],[aria-label*='delete' i],[title*='remove' i],[title*='close' i],[title*='delete' i],.closeIconB,[class*='close' i],[class*='remove' i],[class*='delete' i]"
        );
        if (!(remove instanceof Element) || isVisible(remove)) return null;
        const selectors = selectorCandidatesFor(remove);
        if (selectors.length === 0) return null;
        const itemText = textOf(item);
        if (!itemText) return null;
        const rect = item.getBoundingClientRect();
        const view = item.ownerDocument.defaultView ?? window;
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
        return {
          role: "button",
          name: `Remove ${itemText}`.slice(0, 180),
          tag: remove.tagName.toLowerCase(),
          selector: selectors[0],
          alternative_selectors: selectors.slice(1, 5),
          frame: context.frame,
          ...(context.frameSelector ? { frame_selector: context.frameSelector } : {}),
          ...(context.frameSelectors.length > 1 ? { frame_selectors: context.frameSelectors } : {}),
          disabled: false,
          checked: null,
          hidden_until_hover: true,
          container_selector: selectorFor(item),
          in_viewport: inViewport,
          x: Math.round(context.offsetX + rect.right - Math.min(10, rect.width / 4)),
          y: Math.round(context.offsetY + rect.top + rect.height / 2),
          _priority: (inViewport ? 100 : 0) + 100 + 150 + 80
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
  );
  const snapshotSeen = new Set<string>();
  const snapshotElements = [...snapshotCandidates, ...hiddenRemoveCandidates]
    .sort((left, right) => right._priority - left._priority)
    .filter((item) => {
      const key = `${item.frame}|${item.selector}`;
      if (snapshotSeen.has(key)) return false;
      snapshotSeen.add(key);
      return true;
    })
    .slice(0, 100)
    .map(({ _priority, ...item }, index) => ({ ref: `@e${index + 1}`, ...item }));
  const snapshotId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function elementsAcrossContexts(selector: string) {
    return allContexts.flatMap((context) => Array.from(context.doc.querySelectorAll(selector)));
  }

  // Zoho increments composer id suffixes (ceSubject_1, ceSubject_2, ...) when
  // composers are reopened. Prefer the last visible instance (the most
  // recently mounted composer) and never assume the _1 instance is current.
  function pickComposerElement(selector: string) {
    const matches = elementsAcrossContexts(selector);
    const visible = matches.filter(isVisible);
    if (visible.length > 0) return visible[visible.length - 1];
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  function composerChipTexts(selector: string) {
    const matches = elementsAcrossContexts(selector);
    const visible = matches.filter(isVisible);
    return (visible.length > 0 ? visible : matches).map(textOf).filter(Boolean);
  }

  const subject = pickComposerElement("[id^='ceSubject_']");
  const toInput = pickComposerElement("[id^='ceToAddr_']");
  const ccInput = pickComposerElement("[id^='ceCCAddr_']");
  const editor = pickComposerElement("#editorDiv");
  const signature = pickComposerElement("#ecw_signature");
  const toChips = composerChipTexts('[id^="ceToAddrDetails"] li.selectedEmail');
  const ccChips = composerChipTexts('[id^="ceCCAddrDetails"] li.selectedEmail');
  const composerDetected = Boolean(subject || toInput || editor || signature || toChips.length || ccChips.length);
  const composer = composerDetected
    ? {
        to_chips: toChips,
        cc_chips: ccChips,
        to_input: toInput ? valueOf(toInput) : null,
        cc_input: ccInput ? valueOf(ccInput) : null,
        subject: subject ? valueOf(subject) : null,
        body_text: editor
          ? (editor.textContent ?? "").replace(/\r/g, "").trim().slice(0, 4000)
          : null,
        signature_present: Boolean(signature?.isConnected),
        signature_text: signature ? textOf(signature) : null
      }
    : null;

  const recoveryHint = location.pathname.includes("/tab/Home")
    ? "Zoho Home is a recoverable navigation state. If the task or recent conversation contains a known record URL/id, use ui_step open_url to navigate there, wait for the expected record, and continue. Stop only when the target identity is unknown or ambiguous."
    : null;
      const result = {
        url: location.href,
        title: document.title,
        recovery_hint: recoveryHint,
    verification_hint: composerDetected
      ? "Composer detected. Use composer.to_chips, cc_chips, subject, body_text, and signature_present as read-back evidence; if a required value is absent, perform one targeted browser_eval/browser_observe before reporting failure."
      : null,
        composer,
        snapshot: {
          id: snapshotId,
          url: location.href,
          count: snapshotElements.length,
          elements: snapshotElements
        },
        target_context,
        removable_items: tokenLikeRemovableItems(allContexts),
        scope_selector: scopeSelector || null,
        frames_observed: allContexts.map((context) => context.frame),
        warnings: scoped.warnings,
        headings,
    controls
  };
  const json = JSON.stringify(result);
  if (json.length <= LIMIT) return { ok: true, result };
  return {
    ok: true,
    result: {
      url: result.url,
      title: result.title,
      recovery_hint: result.recovery_hint,
      verification_hint: result.verification_hint,
      composer: result.composer,
      snapshot: result.snapshot,
      target_context: result.target_context,
      removable_items: result.removable_items,
      truncated: true,
      preview: json.slice(0, LIMIT)
    }
  };

  function tokenLikeRemovableItems(contexts: ObserveContext[]) {
    const seen = new Set<string>();
    const items: Array<{
      text: string;
      selector: string;
      remove_selector: string;
      reveal_on_hover: boolean;
      frame: string;
      x: number;
      y: number;
    }> = [];
    const containerSelector = [
      "li.selectedEmail",
      "[role='option']",
      "[role='listitem']",
      "[class*='chip']",
      "[class*='Chip']",
      "[class*='tag']",
      "[class*='Tag']",
      "[class*='pill']",
      "[class*='Pill']",
      "[class*='token']",
      "[class*='Token']"
    ].join(",");
    const removeSelector = [
      "button[aria-label*='remove' i]",
      "button[aria-label*='close' i]",
      "button[aria-label*='delete' i]",
      "[role='button'][aria-label*='remove' i]",
      "[role='button'][aria-label*='close' i]",
      "[role='button'][aria-label*='delete' i]",
      "[title*='remove' i]",
      "[title*='close' i]",
      "[title*='delete' i]",
      ".closeIconB",
      ".close",
      ".remove",
      ".delete",
      "[class*='close' i]",
      "[class*='remove' i]",
      "[class*='delete' i]"
    ].join(",");
    for (const context of contexts) {
      for (const element of Array.from(context.root.querySelectorAll?.(containerSelector) ?? [])) {
        if (!isVisible(element)) continue;
        const remove = element.querySelector(removeSelector);
        // Some remove controls only become visible while their item is hovered.
        // Keep them observable so remove_item can hover, re-locate, and click.
        if (!(remove instanceof Element)) continue;
        const removeVisible = isVisible(remove);
        const text = textOf(element);
        if (!text) continue;
        const selector = selectorFor(element);
        const removeSelectorForElement = selectorFor(remove);
        const key = `${context.frame}:${selector}:${removeSelectorForElement}:${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rect = remove.getBoundingClientRect();
        items.push({
          text,
          selector,
          remove_selector: removeSelectorForElement,
          reveal_on_hover: !removeVisible,
          frame: context.frame,
          x: Math.round(context.offsetX + rect.left + rect.width / 2),
          y: Math.round(context.offsetY + rect.top + rect.height / 2)
        });
      }
    }
    return items.slice(0, 40);
  }
}

async function crmTabForJob(job: ToolJob) {
  const dedicated = requiresDedicatedAgentWindow(job);
  const stored = await usableStoredTab(dedicated);
  if (stored?.id) return stored;

  if (dedicated) {
    // Never fall back to a user's arbitrary CRM tab for UI work. Create a
    // separate background window and drive it by tab id.
    return createAgentWindow(initialUrlForJob(job));
  }

  // API jobs can reuse any open CRM tab quietly; session calls do not need the
  // tab or its window to become active.
  const tabs = await crmTabs();
  const existing = tabs.find((tab) => typeof tab.id === "number") ?? null;
  if (existing?.id) {
    await saveAgentTarget(existing.windowId ?? null, existing.id, false);
    return existing;
  }

  // No CRM tab anywhere: open the dedicated window quietly.
  return createAgentWindow(initialUrlForJob(job));
}

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
    function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function assertCrmTab(tabId: number): Promise<PageResult | null> {
  const tab = await chrome.tabs.get(tabId);
  const url = typeof tab.url === "string" ? tab.url : "";
  try {
    if (new URL(url).hostname === "crm.zoho.com") return null;
  } catch {
    // Fall through to the standard failure.
  }
  return { ok: false, error_message: "UI steps can run only in crm.zoho.com tabs." };
}

async function composerDetectedInTab(tabId: number) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      function rootHasComposerSignature(root: ParentNode) {
        if (root.querySelector("#ecw_signature,#editorDiv")) return true;
        for (const iframe of root.querySelectorAll("iframe")) {
          try {
            if (iframe instanceof HTMLIFrameElement && iframe.contentDocument?.querySelector("#ecw_signature,#editorDiv")) return true;
          } catch {
            // Cross-origin frames are not the Zoho composer surface.
          }
        }
        return false;
      }
      function rootHasComposerRecipients(root: ParentNode) {
        return Boolean(root.querySelector("[id^='ceToAddr_'],[id^='ceCCAddr_'],[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']"));
      }
      function hasComposer(doc: Document) {
        if (doc.querySelector("#ecw_signature,#editorDiv")) return true;
        const overlayRoots = [
          doc.documentElement,
          ...doc.querySelectorAll(
            "[role='dialog'],[aria-modal='true'],.lyteModal,.lytePopup,.modal,.zc-modal,.crm-popup,.popup-model-content,[class*='compose'],[class*='Compose'],[id*='compose'],[id*='Compose']"
          )
        ];
        return overlayRoots.some((root) => rootHasComposerRecipients(root) && rootHasComposerSignature(root));
      }
      if (hasComposer(document)) return true;
      for (const iframe of document.querySelectorAll("iframe")) {
        try {
          if (iframe.contentDocument && hasComposer(iframe.contentDocument)) return true;
        } catch {
          // Cross-origin frames are not the Zoho composer surface.
        }
      }
      return false;
    }
  });
  return results?.[0]?.result === true;
}

type ComposerMutationMark = {
  composerDetected: boolean;
  stateChanging: boolean;
};

async function composerMutationMark(tabId: number, job: ToolJob): Promise<ComposerMutationMark> {
  if (job.tool_name !== "browser_input" && job.tool_name !== "browser_eval") {
    return { composerDetected: false, stateChanging: false };
  }
  return {
    composerDetected: await composerDetectedInTab(tabId),
    stateChanging: job.tool_name === "browser_input" || job.tool_name === "browser_eval"
  };
}

function withComposerGateResult(response: PageResult, mark: ComposerMutationMark): PageResult {
  if (!mark.composerDetected || !mark.stateChanging || !response.ok) return response;
  const result = response.result && typeof response.result === "object" ? (response.result as Record<string, unknown>) : {};
  return {
    ok: true,
    result: {
      ...result,
      composer_gate: { composer_detected: true, state_changing: true }
    }
  };
}

async function captureEvidence(tabId?: number) {
  try {
    let dataUrl: string;
    if (typeof tabId === "number") {
      const captured = (await withDebugger(tabId, (target) =>
        debuggerApi().sendCommand(target, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 60,
          fromSurface: true,
          captureBeyondViewport: false
        })
      )) as { data?: unknown };
      if (typeof captured.data !== "string" || !captured.data) throw new Error("CDP screenshot returned no data.");
      dataUrl = `data:image/jpeg;base64,${captured.data}`;
    } else {
      dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    }
    if (dataUrl.length > 500 * 1024) {
      return { screenshot_error: "Screenshot exceeded the 500 KB cap." };
    }
    return { screenshot_data_url: dataUrl };
  } catch (error) {
    return { screenshot_error: error instanceof Error ? error.message : "Could not capture screenshot evidence." };
  }
}

type LocatedUiTarget =
  | {
      ok: true;
      x: number;
      y: number;
      observed: string;
      tag_name: string;
      is_recipient_field?: boolean;
      recipient_kind?: "to" | "cc" | null;
    }
  | { ok: false; error_message: string; result?: unknown };

async function locateUiTarget(tabId: number, step: Record<string, unknown>): Promise<LocatedUiTarget> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (rawStep: Record<string, unknown>) => {
      function textOf(element: Element) {
        return (element.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function valueOf(element: Element) {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          return element.value;
        }
        return textOf(element);
      }
      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
      function scrollableAncestors(element: Element) {
        const ancestors: Element[] = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = (parent.ownerDocument.defaultView ?? window).getComputedStyle(parent);
          const overflowY = style.overflowY.toLowerCase();
          if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) {
            ancestors.push(parent);
          }
        }
        return ancestors;
      }
      function scrollElementIntoAncestors(element: Element) {
        for (const ancestor of scrollableAncestors(element)) {
          const ancestorRect = ancestor.getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          if (rect.top < ancestorRect.top) {
            ancestor.scrollTop -= ancestorRect.top - rect.top + 12;
          } else if (rect.bottom > ancestorRect.bottom) {
            ancestor.scrollTop += rect.bottom - ancestorRect.bottom + 12;
          }
        }
      }
      function nearestFixedOverlay(element: Element) {
        for (let parent: Element | null = element; parent; parent = parent.parentElement) {
          if ((parent.ownerDocument.defaultView ?? window).getComputedStyle(parent).position === "fixed") return parent;
        }
        return null;
      }
      function frameContext() {
        const frameSelectors = Array.isArray(rawStep.frame_selectors)
          ? rawStep.frame_selectors.filter((value): value is string => typeof value === "string" && Boolean(value))
          : typeof rawStep.frame_selector === "string" && rawStep.frame_selector
            ? [rawStep.frame_selector]
            : [];
        let doc = document;
        let offsetX = 0;
        let offsetY = 0;
        for (const frameSelector of frameSelectors) {
          const frame = doc.querySelector(frameSelector) as HTMLIFrameElement | null;
          if (!frame || !["iframe", "frame"].includes(frame.tagName.toLowerCase()) || !frame.contentDocument) {
            return { error: `Frame was not found: ${frameSelector}` };
          }
          const rect = frame.getBoundingClientRect();
          offsetX += rect.left;
          offsetY += rect.top;
          doc = frame.contentDocument;
        }
        return { doc, offsetX, offsetY };
      }
      const ctx = frameContext();
      if ("error" in ctx) return { ok: false, error_message: ctx.error };

      const selectors = [
        typeof rawStep.selector === "string" ? rawStep.selector : "",
        ...(Array.isArray(rawStep.alternative_selectors)
          ? rawStep.alternative_selectors.filter((value): value is string => typeof value === "string")
          : [])
      ].filter(Boolean);
      const text = typeof rawStep.text === "string" ? rawStep.text.trim().toLowerCase() : "";
      let element: Element | null = null;
      let ambiguous = false;
      for (const selector of selectors) {
        let matches: Element[] = [];
        try {
          matches = Array.from(ctx.doc.querySelectorAll(selector));
        } catch {
          continue;
        }
        if (matches.length === 1) {
          element = matches[0];
          break;
        }
        const visibleMatches = matches.filter(isVisible);
        if (visibleMatches.length === 1) {
          element = visibleMatches[0];
          break;
        }
        if (matches.length > 1) ambiguous = true;
      }
      if (!element && text) {
        const all = [...ctx.doc.querySelectorAll("button,a,input,textarea,select,[role='button'],[role='option'],[tabindex],span,div")].filter(isVisible);
        element =
          all.find((candidate) => textOf(candidate).toLowerCase() === text) ??
          all.find((candidate) => textOf(candidate).toLowerCase().includes(text)) ??
          null;
      }
      if (!element || !isVisible(element)) {
        return {
          ok: false,
          error_message: ambiguous
            ? "Browser element reference became ambiguous. Run browser_observe again."
            : "Browser element reference is stale, missing, or hidden. Run browser_observe again.",
          result: { stale_ref: Boolean(rawStep.ref), ref: rawStep.ref ?? null, selectors }
        };
      }
      if (
        rawStep.type === "fill_field" &&
        element instanceof HTMLElement &&
        element.querySelector("#ecw_signature")
      ) {
        return {
          ok: false,
          error_message:
            "Refused to replace an editor containing #ecw_signature. Insert the email body before the signature with browser_eval."
        };
      }

      element.scrollIntoView({ block: "center", inline: "center" });
      scrollElementIntoAncestors(element);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rect = element.getBoundingClientRect();
      const view = window;
      const left = ctx.offsetX + rect.left;
      const right = ctx.offsetX + rect.right;
      const top = ctx.offsetY + rect.top;
      const bottom = ctx.offsetY + rect.bottom;
      const intersects = bottom > 0 && top < view.innerHeight && right > 0 && left < view.innerWidth;
      if (!intersects) {
        const fixedOverlay = nearestFixedOverlay(element);
        return {
          ok: false,
          error_message: "UI target was found but is outside the clickable viewport after scrolling.",
          result: {
            rect: {
              left,
              right,
              top,
              bottom,
              width: rect.width,
              height: rect.height
            },
            innerWidth: view.innerWidth,
            innerHeight: view.innerHeight,
            fixed_overlay: Boolean(fixedOverlay),
            fixed_overlay_tag: fixedOverlay?.tagName.toLowerCase() ?? null,
            fixed_overlay_class: fixedOverlay?.getAttribute("class") ?? null
          }
        };
      }
      const x = Math.round(Math.min(Math.max(left + rect.width / 2, 1), view.innerWidth - 1));
      const y = Math.round(Math.min(Math.max(top + rect.height / 2, 1), view.innerHeight - 1));
      // Zoho recipient chip fields ([id^='ceToAddr_'] / [id^='ceCCAddr_'])
      // only commit text into a chip on a key event, so callers must know
      // when they are typing into one.
      const ccField =
        element.matches("[id^='ceCCAddr_']") || Boolean(element.closest("[id^='ceCCAddrDetails']"));
      const toField =
        element.matches("[id^='ceToAddr_']") || Boolean(element.closest("[id^='ceToAddrDetails']"));
      return {
        ok: true,
        x,
        y,
        observed: valueOf(element),
        tag_name: element.tagName.toLowerCase(),
        is_recipient_field: ccField || toField,
        recipient_kind: ccField ? ("cc" as const) : toField ? ("to" as const) : null
      };
    },
    args: [step]
  });
  const located = results?.[0]?.result as LocatedUiTarget | undefined;
  return located ?? { ok: false, error_message: "UI locator returned no result." };
}

// NOTE: trusted input intentionally runs against the tab's real viewport.
// A per-action Emulation.setDeviceMetricsOverride used to force a 1440x2200
// layout for every click, which reflowed the page between coordinate
// measurement and CDP dispatch and made small targets (recipient chips,
// chip remove icons, Cc/Bcc links) miss. Coordinates are now measured in the
// same layout the events are dispatched into.
async function withDebugger<T>(tabId: number, run: (target: chrome.Debuggee) => Promise<T>) {
  const target = { tabId };
  let attached = false;
  try {
    await debuggerApi().attach(target, "1.3");
    attached = true;
    return await run(target);
  } finally {
    if (attached) {
      await debuggerApi().detach(target).catch(() => undefined);
    }
  }
}

async function assertSendGuardAllowsClick(tabId: number, x: number, y: number): Promise<PageResult | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (clientX: number, clientY: number) => {
      function normalizedLabel(value: unknown) {
        return String(value ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      }
      function controlInfo(element: Element) {
        const el = element as HTMLInputElement;
        return {
          text: element.textContent ?? "",
          value: el.value ?? "",
          ariaLabel: element.getAttribute("aria-label") ?? "",
          title: element.getAttribute("title") ?? "",
          role: element.getAttribute("role") ?? ""
        };
      }
      function accessibleNames(element: Element) {
        const info = controlInfo(element);
        return [info.ariaLabel, info.value, info.title, info.text].map(normalizedLabel).filter(Boolean);
      }
      function isScheduleControl(element: Element) {
        return accessibleNames(element).some((name) => name === "schedule" || name === "schedule & close");
      }
      function isSendNowControl(element: Element) {
        if (isScheduleControl(element)) return false;
        const role = normalizedLabel(element.getAttribute("role") ?? "");
        const buttonish = !role || role === "button" || role === "menuitem" || role === "link";
        if (!buttonish) return false;
        return accessibleNames(element).some((name) => name === "send" || name === "send email" || name === "send now" || name === "send mail");
      }
      function rootHasComposerSignature(root: Element) {
        if (root.querySelector("#ecw_signature")) return true;
        for (const iframe of root.querySelectorAll("iframe")) {
          try {
            if (iframe instanceof HTMLIFrameElement && iframe.contentDocument?.querySelector("#ecw_signature")) return true;
          } catch {
            // Cross-origin frames are not part of the same-origin Zoho composer surface.
          }
        }
        return false;
      }
      function rootHasComposerRecipients(root: Element) {
        return Boolean(root.querySelector("[id^='ceToAddr_'],[id^='ceCCAddr_'],[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']"));
      }
      function isInsideComposerSurface(element: Element) {
        const directComposerElement = element.closest(
          "[id^='ceSubject_'],[id^='ceToAddr_'],[id^='ceCCAddr_'],#editorDiv,#ecw_signature,#z_editor,[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']"
        );
        if (directComposerElement) return true;
        const composerRootSelector =
          "[role='dialog'],[aria-modal='true'],.lyteModal,.lytePopup,.modal,.zc-modal,.crm-popup,.popup-model-content,[class*='compose'],[class*='Compose'],[id*='compose'],[id*='Compose']";
        for (let root = element.closest(composerRootSelector); root; root = root.parentElement?.closest(composerRootSelector) ?? null) {
          if (rootHasComposerRecipients(root) && rootHasComposerSignature(root)) return true;
        }
        return false;
      }
      const target = document.elementFromPoint(clientX, clientY);
      const candidate = target?.closest("button,a,input,[role='button'],span,div") ?? null;
      if (!candidate) return { blocked: false };
      return {
        blocked: isInsideComposerSurface(candidate) && isSendNowControl(candidate),
        inside_composer_surface: isInsideComposerSurface(candidate),
        label: accessibleNames(candidate).join(" | ")
      };
    },
    args: [x, y]
  });
  const checked = results?.[0]?.result as { blocked?: unknown; label?: unknown } | undefined;
  if (checked?.blocked === true) {
    return { ok: false, error_message: SEND_NOW_BLOCKED_MESSAGE, result: { send_now_blocked: true, label: checked.label ?? "" } };
  }
  return null;
}

async function assertSendGuardAllowsFocusedEnter(tabId: number, key: string): Promise<PageResult | null> {
  if (!isPlainEnterKey(key)) return null;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      function normalizedLabel(value: unknown) {
        return String(value ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      }
      function accessibleNames(element: Element) {
        const el = element as HTMLInputElement;
        return [
          element.getAttribute("aria-label") ?? "",
          el.value ?? "",
          element.getAttribute("title") ?? "",
          element.textContent ?? ""
        ]
          .map(normalizedLabel)
          .filter(Boolean);
      }
      function isScheduleControl(element: Element) {
        return accessibleNames(element).some((name) => name === "schedule" || name === "schedule & close");
      }
      function isSendNowControl(element: Element) {
        if (isScheduleControl(element)) return false;
        const role = normalizedLabel(element.getAttribute("role") ?? "");
        const buttonish = !role || role === "button" || role === "menuitem" || role === "link";
        if (!buttonish) return false;
        return accessibleNames(element).some((name) => name === "send" || name === "send email" || name === "send now" || name === "send mail");
      }
      function rootHasComposerSignature(root: Element) {
        if (root.querySelector("#ecw_signature")) return true;
        for (const iframe of root.querySelectorAll("iframe")) {
          try {
            if (iframe instanceof HTMLIFrameElement && iframe.contentDocument?.querySelector("#ecw_signature")) return true;
          } catch {
            // Cross-origin frames are not part of the same-origin Zoho composer surface.
          }
        }
        return false;
      }
      function rootHasComposerRecipients(root: Element) {
        return Boolean(root.querySelector("[id^='ceToAddr_'],[id^='ceCCAddr_'],[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']"));
      }
      function isInsideComposerSurface(element: Element) {
        const directComposerElement = element.closest(
          "[id^='ceSubject_'],[id^='ceToAddr_'],[id^='ceCCAddr_'],#editorDiv,#ecw_signature,#z_editor,[id^='ceToAddrDetails'],[id^='ceCCAddrDetails']"
        );
        if (directComposerElement) return true;
        const composerRootSelector =
          "[role='dialog'],[aria-modal='true'],.lyteModal,.lytePopup,.modal,.zc-modal,.crm-popup,.popup-model-content,[class*='compose'],[class*='Compose'],[id*='compose'],[id*='Compose']";
        for (let root = element.closest(composerRootSelector); root; root = root.parentElement?.closest(composerRootSelector) ?? null) {
          if (rootHasComposerRecipients(root) && rootHasComposerSignature(root)) return true;
        }
        return false;
      }
      const active = document.activeElement;
      const candidate = active instanceof Element ? active.closest("button,a,input,[role='button'],span,div") : null;
      if (!candidate) return { blocked: false };
      return {
        blocked: isInsideComposerSurface(candidate) && isSendNowControl(candidate),
        inside_composer_surface: isInsideComposerSurface(candidate),
        label: accessibleNames(candidate).join(" | ")
      };
    }
  });
  const checked = results?.[0]?.result as { blocked?: unknown; label?: unknown } | undefined;
  if (checked?.blocked === true) {
    return { ok: false, error_message: SEND_NOW_BLOCKED_MESSAGE, result: { send_now_blocked: true, label: checked.label ?? "" } };
  }
  return null;
}

async function dispatchTrustedClick(target: chrome.Debuggee, x: number, y: number) {
  await debuggerApi().sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await debuggerApi().sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1
  });
  await debuggerApi().sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1
  });
}

function keyParams(key: string) {
  if (key === "Enter") return { key, code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  if (key === "Tab") return { key, code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
  if (key === "Escape") return { key, code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), nativeVirtualKeyCode: upper.charCodeAt(0) };
  }
  return { key, code: key, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
}

async function dispatchTrustedKey(target: chrome.Debuggee, key: string) {
  if (isModifierEnterKey(key)) throw new Error(SEND_NOW_BLOCKED_MESSAGE);
  const params = keyParams(key);
  await debuggerApi().sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await debuggerApi().sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

async function hoverTrusted(target: chrome.Debuggee, x: number, y: number) {
  await debuggerApi().sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function replaceFocusedText(target: chrome.Debuggee, value: string) {
  await debuggerApi().sendCommand(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });
  await debuggerApi().sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });
  await debuggerApi().sendCommand(target, "Input.insertText", { text: value });
}

function usesTrustedInput(step: Record<string, unknown>) {
  const type = String(step.type ?? "");
  return type === "click" || type === "fill_field" || type === "press_key" || type === "remove_item" || type === "hover";
}

async function locateRemoveAffordance(tabId: number, step: Record<string, unknown>): Promise<LocatedUiTarget> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (rawStep: Record<string, unknown>) => {
      function textOf(element: Element) {
        return (element.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
      function frameContext() {
        const frameSelectors = Array.isArray(rawStep.frame_selectors)
          ? rawStep.frame_selectors.filter((value): value is string => typeof value === "string" && Boolean(value))
          : typeof rawStep.frame_selector === "string" && rawStep.frame_selector
            ? [rawStep.frame_selector]
            : [];
        let doc = document;
        let offsetX = 0;
        let offsetY = 0;
        for (const frameSelector of frameSelectors) {
          const frame = doc.querySelector(frameSelector) as HTMLIFrameElement | null;
          if (!frame || !["iframe", "frame"].includes(frame.tagName.toLowerCase()) || !frame.contentDocument) {
            return { error: `Frame was not found: ${frameSelector}` };
          }
          const rect = frame.getBoundingClientRect();
          offsetX += rect.left;
          offsetY += rect.top;
          doc = frame.contentDocument;
        }
        return { doc, offsetX, offsetY };
      }
      function distanceBetween(a: DOMRect, b: DOMRect) {
        const ax = a.left + a.width / 2;
        const ay = a.top + a.height / 2;
        const bx = b.left + b.width / 2;
        const by = b.top + b.height / 2;
        return Math.hypot(ax - bx, ay - by);
      }

      const ctx = frameContext();
      if ("error" in ctx) return { ok: false, error_message: ctx.error };
      const doc = ctx.doc;
      const selectors = [
        typeof rawStep.selector === "string" ? rawStep.selector : "",
        ...(Array.isArray(rawStep.alternative_selectors)
          ? rawStep.alternative_selectors.filter((value): value is string => typeof value === "string")
          : [])
      ].filter(Boolean);
      const text = typeof rawStep.text === "string" ? rawStep.text.trim().toLowerCase() : "";
      const tokenSelector = [
        "li.selectedEmail",
        "[role='option']",
        "[role='listitem']",
        "[class*='chip']",
        "[class*='Chip']",
        "[class*='tag']",
        "[class*='Tag']",
        "[class*='pill']",
        "[class*='Pill']",
        "[class*='token']",
        "[class*='Token']",
        "button",
        "[role='button']",
        "span",
        "div"
      ].join(",");
      const removeSelector = [
        "button[aria-label*='remove' i]",
        "button[aria-label*='close' i]",
        "button[aria-label*='delete' i]",
        "[role='button'][aria-label*='remove' i]",
        "[role='button'][aria-label*='close' i]",
        "[role='button'][aria-label*='delete' i]",
        "[title*='remove' i]",
        "[title*='close' i]",
        "[title*='delete' i]",
        ".closeIconB",
        ".close",
        ".remove",
        ".delete",
        "[class*='close' i]",
        "[class*='remove' i]",
        "[class*='delete' i]",
        "[aria-label='×']",
        "[aria-label='x']"
      ].join(",");

      let item: Element | null = null;
      for (const selector of selectors) {
        let matches: Element[] = [];
        try {
          matches = Array.from(doc.querySelectorAll(selector));
        } catch {
          continue;
        }
        if (matches.length === 1 && isVisible(matches[0])) {
          item = matches[0];
          break;
        }
        const visible = matches.filter(isVisible);
        if (visible.length === 1) {
          item = visible[0];
          break;
        }
      }
      if (!item && text) {
        const candidates = Array.from(doc.querySelectorAll(tokenSelector)).filter(isVisible);
        item =
          candidates.find((candidate) => textOf(candidate).toLowerCase() === text) ??
          candidates.find((candidate) => textOf(candidate).toLowerCase().includes(text)) ??
          null;
      }
      if (!item) return { ok: false, error_message: "Removable UI item reference is stale. Run browser_observe again." };

      await new Promise((resolve) => requestAnimationFrame(resolve));
      const itemRect = item.getBoundingClientRect();
      const scope =
        item.closest(
          "[role='dialog'],[aria-modal='true'],.lyteModal,.lytePopup,.modal,.zc-modal,.crm-popup,.popup-model-content,[class*='compose'],[class*='Compose'],[id*='compose'],[id*='Compose'],ul,ol"
        ) ?? doc;
      const relatives = [
        item,
        item.nextElementSibling,
        item.previousElementSibling,
        item.parentElement,
        item.parentElement?.nextElementSibling,
        item.parentElement?.previousElementSibling,
        item.parentElement?.parentElement
      ].filter(Boolean) as Element[];
      const localCandidates = relatives.flatMap((relative) => [
        ...(relative.matches(removeSelector) ? [relative] : []),
        ...Array.from(relative.querySelectorAll(removeSelector))
      ]);
      const scopedCandidates = Array.from(scope.querySelectorAll(removeSelector));
      const candidates = [...new Set([...localCandidates, ...scopedCandidates])]
        .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
        .filter(({ candidate, rect }) => {
          const style = window.getComputedStyle(candidate);
          const hasBox = rect.width > 0 && rect.height > 0;
          if (!hasBox || style.visibility === "hidden" || style.display === "none") return false;
          const verticallyOverlaps = rect.bottom >= itemRect.top - 12 && rect.top <= itemRect.bottom + 12;
          const nearRightEdge = rect.left >= itemRect.left - 16 && rect.left <= itemRect.right + 48;
          const insideOrAdjacent = rect.right >= itemRect.left && rect.left <= itemRect.right + 48;
          return verticallyOverlaps && (nearRightEdge || insideOrAdjacent);
        })
        .sort((left, right) => {
          const rightEdgeBiasLeft = Math.abs(left.rect.left - itemRect.right);
          const rightEdgeBiasRight = Math.abs(right.rect.left - itemRect.right);
          return rightEdgeBiasLeft - rightEdgeBiasRight || distanceBetween(itemRect, left.rect) - distanceBetween(itemRect, right.rect);
        });
      const remove = candidates[0];
      if (!remove) {
        return {
          ok: false,
          error_message: "Remove/close control was not found for the matched UI item after trusted hover.",
          result: {
            matched_text: textOf(item),
            matched_tag: item.tagName.toLowerCase(),
            matched_class: item.getAttribute("class") ?? "",
            matched_rect: {
              left: itemRect.left,
              top: itemRect.top,
              right: itemRect.right,
              bottom: itemRect.bottom,
              width: itemRect.width,
              height: itemRect.height
            },
            nearby_remove_candidates: scopedCandidates.slice(0, 30).map((candidate) => ({
              tag: candidate.tagName.toLowerCase(),
              text: textOf(candidate),
              class: candidate.getAttribute("class") ?? "",
              aria_label: candidate.getAttribute("aria-label") ?? "",
              title: candidate.getAttribute("title") ?? "",
              visible: isVisible(candidate),
              rect: (() => {
                const rect = candidate.getBoundingClientRect();
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
              })()
            }))
          }
        };
      }
      const view = window;
      const left = ctx.offsetX + remove.rect.left;
      const top = ctx.offsetY + remove.rect.top;
      const x = Math.round(Math.min(Math.max(left + remove.rect.width / 2, 1), view.innerWidth - 1));
      const y = Math.round(Math.min(Math.max(top + remove.rect.height / 2, 1), view.innerHeight - 1));
      return {
        ok: true,
        x,
        y,
        observed: textOf(item),
        tag_name: remove.candidate.tagName.toLowerCase()
      };
    },
    args: [step]
  });
  const located = results?.[0]?.result as LocatedUiTarget | undefined;
  return located ?? { ok: false, error_message: "Remove affordance locator returned no result." };
}

type FilledFieldReadBack = {
  found: boolean;
  value: string | null;
  to_chips: Array<{ text: string; email: string | null }>;
  cc_chips: Array<{ text: string; email: string | null }>;
  to_input: string | null;
  cc_input: string | null;
};

// Read the actual post-input state of a filled field: the element's real
// value plus the committed recipient chips. This is the evidence returned to
// the model instead of echoing the requested value back as "observed".
async function readFilledFieldState(tabId: number, step: Record<string, unknown>): Promise<FilledFieldReadBack | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (rawStep: Record<string, unknown>) => {
      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
      function valueOf(element: Element) {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          return element.value;
        }
        if (element instanceof HTMLElement && element.isContentEditable) {
          return (element.innerText || element.textContent || "").replace(/\r/g, "").trim();
        }
        return (element.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      function frameContext() {
        const frameSelectors = Array.isArray(rawStep.frame_selectors)
          ? rawStep.frame_selectors.filter((value): value is string => typeof value === "string" && Boolean(value))
          : typeof rawStep.frame_selector === "string" && rawStep.frame_selector
            ? [rawStep.frame_selector]
            : [];
        let doc = document;
        for (const frameSelector of frameSelectors) {
          const frame = doc.querySelector(frameSelector) as HTMLIFrameElement | null;
          if (!frame || !frame.contentDocument) return document;
          doc = frame.contentDocument;
        }
        return doc;
      }
      function composerDocs() {
        const docs: Document[] = [document];
        for (const iframe of document.querySelectorAll("iframe")) {
          try {
            if (iframe instanceof HTMLIFrameElement && iframe.contentDocument) docs.push(iframe.contentDocument);
          } catch {
            // Cross-origin frames are not the Zoho composer surface.
          }
        }
        return docs;
      }
      function acrossDocs(selector: string) {
        return composerDocs().flatMap((doc) => [...doc.querySelectorAll(selector)]);
      }
      function chipData(selector: string) {
        const matches = acrossDocs(selector);
        const visible = matches.filter(isVisible);
        return (visible.length > 0 ? visible : matches).map((element) => ({
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
          email:
            (element.getAttribute("email") || element.getAttribute("title") || "").trim().toLowerCase() || null
        }));
      }
      function inputValue(selector: string) {
        const matches = acrossDocs(selector);
        const visible = matches.filter(isVisible);
        const input = visible[visible.length - 1] ?? matches[matches.length - 1] ?? null;
        return input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input.value : null;
      }

      const doc = frameContext();
      const selectors = [
        typeof rawStep.selector === "string" ? rawStep.selector : "",
        ...(Array.isArray(rawStep.alternative_selectors)
          ? rawStep.alternative_selectors.filter((value): value is string => typeof value === "string")
          : [])
      ].filter(Boolean);
      let element: Element | null = null;
      for (const selector of selectors) {
        let matches: Element[] = [];
        try {
          matches = Array.from(doc.querySelectorAll(selector));
        } catch {
          continue;
        }
        const visible = matches.filter(isVisible);
        element = visible[0] ?? matches[0] ?? null;
        if (element) break;
      }
      if (!element && doc.activeElement instanceof Element && doc.activeElement !== doc.body) {
        element = doc.activeElement;
      }
      return {
        found: Boolean(element),
        value: element ? valueOf(element) : null,
        to_chips: chipData('[id^="ceToAddrDetails"] li.selectedEmail'),
        cc_chips: chipData('[id^="ceCCAddrDetails"] li.selectedEmail'),
        to_input: inputValue("[id^='ceToAddr_']"),
        cc_input: inputValue("[id^='ceCCAddr_']")
      };
    },
    args: [step]
  });
  const readback = results?.[0]?.result as FilledFieldReadBack | undefined;
  return readback ?? null;
}

function chipMatchesRequested(chip: { text: string; email: string | null }, requestedLower: string) {
  return (chip.email ?? "").includes(requestedLower) || chip.text.toLowerCase().includes(requestedLower);
}

async function runTrustedUiStep(tabId: number, step: Record<string, unknown>): Promise<PageResult> {
  const type = String(step.type ?? "");
  if (type === "press_key") {
    const key = String(step.key ?? "");
    const repeat = Math.min(20, Math.max(1, typeof step.repeat === "number" && Number.isInteger(step.repeat) ? step.repeat : 1));
    if (isModifierEnterKey(key)) {
      return { ok: false, error_message: SEND_NOW_BLOCKED_MESSAGE, result: { send_now_blocked: true } };
    }
    const guarded = await withDebugger(tabId, async (target) => {
      if (typeof step.selector === "string" || typeof step.text === "string") {
        const located = await locateUiTarget(tabId, step);
        if (!located.ok) return { ok: false, error_message: located.error_message, result: located.result } satisfies PageResult;
        await dispatchTrustedClick(target, located.x, located.y);
      }
      for (let index = 0; index < repeat; index += 1) {
        const enterGuard = await assertSendGuardAllowsFocusedEnter(tabId, key);
        if (enterGuard) return enterGuard;
        await dispatchTrustedKey(target, key);
      }
      return null;
    });
    if (guarded) return guarded;
    return {
      ok: true,
      result: { observed: `trusted key ${key}`, repeat, input_method: "cdp", trusted: true }
    };
  }

  return withDebugger(tabId, async (target) => {
    const located = await locateUiTarget(tabId, step);
    if (!located.ok) return { ok: false, error_message: located.error_message, result: located.result };
    if (type === "remove_item") {
      await hoverTrusted(target, located.x, located.y);
      const remove = await locateRemoveAffordance(tabId, step);
      if (!remove.ok) return { ok: false, error_message: remove.error_message, result: remove.result };
      await dispatchTrustedClick(target, remove.x, remove.y);
      return {
        ok: true,
        result: {
          observed: remove.observed,
          input_method: "cdp",
          trusted: true,
          action: "remove",
          coordinates: { x: remove.x, y: remove.y }
        }
      };
    }
    if (type === "hover") {
      await hoverTrusted(target, located.x, located.y);
      return {
        ok: true,
        result: {
          observed: located.observed,
          input_method: "cdp",
          trusted: true,
          action: "hover",
          coordinates: { x: located.x, y: located.y }
        }
      };
    }
    if (type === "click") {
      const sendGuard = await assertSendGuardAllowsClick(tabId, located.x, located.y);
      if (sendGuard) return sendGuard;
    }
    await dispatchTrustedClick(target, located.x, located.y);
    if (type === "fill_field") {
      const requested = String(step.value ?? "");
      const requestedLower = requested.trim().toLowerCase();
      await replaceFocusedText(target, requested);
      const isRecipient = located.is_recipient_field === true;
      // Recipient chip fields commit only on a key event; Input.insertText
      // alone never tokenizes. Default press_enter to true for them unless
      // the caller explicitly opted out.
      const shouldEnter =
        step.press_enter === true || (isRecipient && step.press_enter !== false && requestedLower !== "");
      if (shouldEnter) {
        const enterGuard = await assertSendGuardAllowsFocusedEnter(tabId, "Enter");
        if (enterGuard) return enterGuard;
        await dispatchTrustedKey(target, "Enter");
      }
      let readback = await readFilledFieldState(tabId, step);
      if (isRecipient && requestedLower) {
        // Wait for the chip to commit (autocomplete resolution can lag).
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          const chips = [...(readback?.to_chips ?? []), ...(readback?.cc_chips ?? [])];
          const committed = chips.some((chip) => chipMatchesRequested(chip, requestedLower));
          const loading = chips.some((chip) => /loading/i.test(chip.text));
          if (committed && !loading) break;
          await sleep(250);
          readback = await readFilledFieldState(tabId, step);
        }
      }
      const actual = readback?.found ? readback.value ?? "" : null;
      const relevantChips = isRecipient
        ? located.recipient_kind === "cc"
          ? readback?.cc_chips ?? []
          : located.recipient_kind === "to"
            ? readback?.to_chips ?? []
            : [...(readback?.to_chips ?? []), ...(readback?.cc_chips ?? [])]
        : [];
      const verified = isRecipient && requestedLower !== ""
        ? relevantChips.some((chip) => chipMatchesRequested(chip, requestedLower))
        : actual !== null && actual.trim() === requested.trim();
      return {
        ok: true,
        result: {
          observed: actual,
          requested_value: requested,
          verified,
          ...(isRecipient
            ? {
                recipient_field: located.recipient_kind ?? true,
                chip_committed: verified,
                press_enter_applied: shouldEnter,
                committed_to_chips: readback?.to_chips ?? [],
                committed_cc_chips: readback?.cc_chips ?? [],
                to_input: readback?.to_input ?? null,
                cc_input: readback?.cc_input ?? null
              }
            : {}),
          ...(verified
            ? {}
            : {
                warning:
                  "Read-back did not confirm the requested value. Do not assume the field is set; observe the current state and correct it before proceeding."
              }),
          input_method: "cdp",
          trusted: true,
          coordinates: { x: located.x, y: located.y }
        }
      };
    }

    return {
      ok: true,
      result: {
        observed: located.observed,
        input_method: "cdp",
        trusted: true,
        verified: false,
        needs_verification: true,
        coordinates: { x: located.x, y: located.y }
      }
    };
  });
}

async function runBackgroundUiStep(tabId: number, step: Record<string, unknown>): Promise<PageResult | null> {
  const type = String(step.type ?? "");

  if (type === "open_url") {
    const url = String(step.url ?? "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error_message: "open_url requires a valid URL." };
    }
    if (parsed.hostname !== "crm.zoho.com") {
      return { ok: false, error_message: "open_url is limited to crm.zoho.com." };
    }
    await chrome.tabs.update(tabId, { url: parsed.toString() });
    await waitForTabComplete(tabId);
    return { ok: true, result: { observed: parsed.toString() } };
  }

  if (type === "screenshot") {
    return { ok: true, result: await captureEvidence() };
  }

  if (type === "remove_item") {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (rawStep: Record<string, unknown>) => {
        function textOf(element: Element) {
          return (element.textContent ?? "").replace(/\s+/g, " ").trim();
        }
        function isVisible(element: Element) {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        }
        function frameContext() {
          const frameSelector = typeof rawStep.frame_selector === "string" ? rawStep.frame_selector : "";
          if (!frameSelector) return { doc: document };
          const frame = document.querySelector(frameSelector);
          if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) {
            return { error: `Frame was not found: ${frameSelector}` };
          }
          return { doc: frame.contentDocument };
        }
        const ctx = frameContext();
        if ("error" in ctx) return { ok: false, error_message: ctx.error };
        const doc = ctx.doc;

        const selector = typeof rawStep.selector === "string" ? rawStep.selector : "";
        const text = typeof rawStep.text === "string" ? rawStep.text.trim().toLowerCase() : "";
        const tokenSelector = [
          "li.selectedEmail",
          "[role='option']",
          "[role='listitem']",
          "[class*='chip']",
          "[class*='Chip']",
          "[class*='tag']",
          "[class*='Tag']",
          "[class*='pill']",
          "[class*='Pill']",
          "[class*='token']",
          "[class*='Token']",
          "button",
          "[role='button']",
          "span",
          "div"
        ].join(",");
        const removeSelector = [
          "button[aria-label*='remove' i]",
          "button[aria-label*='close' i]",
          "button[aria-label*='delete' i]",
          "[role='button'][aria-label*='remove' i]",
          "[role='button'][aria-label*='close' i]",
          "[role='button'][aria-label*='delete' i]",
          "[title*='remove' i]",
          "[title*='close' i]",
          "[title*='delete' i]",
          ".closeIconB",
          ".close",
          ".remove",
          ".delete",
          "[class*='close' i]",
          "[class*='remove' i]",
          "[class*='delete' i]"
        ].join(",");
        let target: Element | null = null;
        if (selector) {
          const selected = doc.querySelector(selector);
          target = selected && isVisible(selected) ? selected : null;
        } else if (text) {
          const candidates = Array.from(doc.querySelectorAll(tokenSelector)).filter(isVisible);
          target =
            candidates.find((candidate) => textOf(candidate).toLowerCase() === text) ??
            candidates.find((candidate) => textOf(candidate).toLowerCase().includes(text)) ??
            null;
        }
        if (!target) return { ok: false, error_message: "Removable UI item was not found." };
        for (const hoverTarget of [target, target.parentElement].filter(Boolean) as Element[]) {
          hoverTarget.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
          hoverTarget.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
        }

        function distanceBetween(a: DOMRect, b: DOMRect) {
          const ax = a.left + a.width / 2;
          const ay = a.top + a.height / 2;
          const bx = b.left + b.width / 2;
          const by = b.top + b.height / 2;
          return Math.hypot(ax - bx, ay - by);
        }
        function nearestRemoverByGeometry(item: Element) {
          const itemRect = item.getBoundingClientRect();
          const scope: ParentNode =
            item.closest(
              "[role='dialog'],[aria-modal='true'],.lyteModal,.lytePopup,.modal,.zc-modal,.crm-popup,.popup-model-content,[class*='compose'],[class*='Compose'],[id*='compose'],[id*='Compose'],ul,ol"
            ) ?? doc;
          const removers = Array.from(scope.querySelectorAll(removeSelector))
            .filter((candidate) => candidate !== item)
            .map((candidate) => {
              const rect = candidate.getBoundingClientRect();
              const visibleEnough = isVisible(candidate) || (rect.width > 0 && rect.height > 0);
              return { candidate, rect, visibleEnough };
            })
            .filter(({ rect, visibleEnough }) => {
              if (!visibleEnough) return false;
              const verticallyOverlaps = rect.bottom >= itemRect.top - 8 && rect.top <= itemRect.bottom + 8;
              const nearRightEdge = rect.left >= itemRect.left - 8 && rect.left <= itemRect.right + 36;
              const insideOrAdjacent = rect.right >= itemRect.left && rect.left <= itemRect.right + 36;
              return verticallyOverlaps && (nearRightEdge || insideOrAdjacent);
            })
            .sort((left, right) => {
              const rightEdgeBiasLeft = Math.abs(left.rect.left - itemRect.right);
              const rightEdgeBiasRight = Math.abs(right.rect.left - itemRect.right);
              return rightEdgeBiasLeft - rightEdgeBiasRight || distanceBetween(itemRect, left.rect) - distanceBetween(itemRect, right.rect);
            });
          return removers[0]?.candidate ?? null;
        }
        function adjacentRemover(item: Element) {
          const relatives = [
            item.nextElementSibling,
            item.previousElementSibling,
            item.parentElement,
            item.parentElement?.nextElementSibling,
            item.parentElement?.previousElementSibling,
            item.parentElement?.parentElement
          ].filter(Boolean) as Element[];
          for (const relative of relatives) {
            if (relative.matches(removeSelector)) return relative;
            const found = relative.querySelector(removeSelector);
            if (found) return found;
          }
          return null;
        }

        const remove =
          target.matches(removeSelector)
            ? target
            : target.querySelector(removeSelector) ??
              adjacentRemover(target) ??
              nearestRemoverByGeometry(target) ??
              null;
        if (!(remove instanceof HTMLElement) || !isVisible(remove)) {
          return {
            ok: false,
            error_message: "Remove/close control was not found for the matched UI item.",
            result: {
              matched_text: textOf(target),
              matched_tag: target.tagName.toLowerCase(),
              matched_class: target.getAttribute("class") ?? "",
              nearby_remove_candidates: Array.from(doc.querySelectorAll(removeSelector))
                .slice(0, 20)
                .map((candidate) => ({
                  tag: candidate.tagName.toLowerCase(),
                  text: textOf(candidate),
                  class: candidate.getAttribute("class") ?? "",
                  aria_label: candidate.getAttribute("aria-label") ?? "",
                  title: candidate.getAttribute("title") ?? "",
                  visible: isVisible(candidate)
                }))
            }
          };
        }
        const before = textOf(target);
        remove.click();
        return { ok: true, result: { removed: before, action: "remove", selector: selector || null, text: text || null } };
      },
      args: [step]
    });
    const result = results?.[0]?.result as PageResult | undefined;
    return result ?? { ok: false, error_message: "Remove action returned no result." };
  }

  return null;
}

async function executeUiStep(tabId: number, step: Record<string, unknown>): Promise<PageResult> {
  try {
    const trusted = usesTrustedInput(step);
    if (!trusted) {
      const backgroundUiResult = await runBackgroundUiStep(tabId, step);
      if (backgroundUiResult) return backgroundUiResult;
    }

    const crmError = await assertCrmTab(tabId);
    if (crmError) return crmError;

    if (trusted) {
      try {
        return await runTrustedUiStep(tabId, step);
      } catch (error) {
        const fallback = await runDomUiStep(tabId, step);
        if (fallback.ok) {
          return {
            ok: true,
            result: {
              ...(fallback.result && typeof fallback.result === "object" ? (fallback.result as Record<string, unknown>) : { result: fallback.result }),
              input_method: "dom_fallback",
              trusted: false,
              cdp_error: error instanceof Error ? error.message : "CDP trusted input failed."
            }
          };
        }
        return fallback;
      }
    }

    return runDomUiStep(tabId, step);
  } catch (error) {
    return {
      ok: false,
      error_message: `Could not run UI step in the Zoho tab${
        error instanceof Error ? `: ${error.message}` : ""
      }. If the extension was just reloaded, refresh the crm.zoho.com tab and try again.`
    };
  }
}

async function runDomUiStep(tabId: number, step: Record<string, unknown>): Promise<PageResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: zohoUiPageRunner,
      args: [{ tool_name: "ui_step", args: { step } }]
    });
    const result = results?.[0]?.result as PageResult | undefined;
    if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
      return {
        ok: false,
        error_message: "Zoho UI executor returned no result (the tab may still be loading). Try again."
      };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      error_message: `Could not run DOM UI step in the Zoho tab${
        error instanceof Error ? `: ${error.message}` : ""
      }. If the extension was just reloaded, refresh the crm.zoho.com tab and try again.`
    };
  }
}

async function runUiWorkflow(tabId: number, job: ToolJob): Promise<PageResult> {
  const steps = Array.isArray(job.args.steps) ? (job.args.steps as Array<Record<string, unknown>>) : [];

  const workflowName = String(job.args.name ?? "ui workflow");
  const outcomes: Array<{ index: number; step_type: string; ok: boolean; observed?: unknown; error_message?: string }> = [];

  if (steps.length === 0) {
    return { ok: true, result: { ok: false, workflow_name: workflowName, error_message: "Workflow has no steps." } };
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] ?? {};
    const response = await executeUiStep(tabId, step);
    if (response.ok) {
      const result = response.result as { observed?: unknown } | null;
      outcomes.push({ index, step_type: String(step.type ?? ""), ok: true, observed: result?.observed ?? result });
      continue;
    }

    const evidence = await captureEvidence();
    const errorMessage = response.error_message ?? "UI workflow step failed.";
    outcomes.push({ index, step_type: String(step.type ?? ""), ok: false, error_message: errorMessage });
    return {
      ok: true,
      result: {
        ok: false,
        workflow_name: workflowName,
        failed_step_index: index,
        error_message: errorMessage,
        steps: outcomes,
        evidence
      }
    };
  }

  return {
    ok: true,
    result: {
      ok: true,
      workflow_name: workflowName,
      steps: outcomes,
      evidence: await captureEvidence()
    }
  };
}

type EmailJobArgs = {
  reference: string;
  deal_url: string;
  deal_zoho_id: string;
  deal_name: string;
  contact_zoho_id: string;
  contact_name: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  schedule_date: string;
  schedule_time: string;
  timezone: string;
  preserve_signature: true;
  new_tasks: Array<{ subject: string; due_date: string }>;
  tasks_to_complete: Array<{ subject: string }>;
};

function emailJobArgs(args: Record<string, unknown>): EmailJobArgs {
  return {
    reference: String(args.reference ?? "email"),
    deal_url: String(args.deal_url ?? ""),
    deal_zoho_id: String(args.deal_zoho_id ?? ""),
    deal_name: String(args.deal_name ?? ""),
    contact_zoho_id: String(args.contact_zoho_id ?? ""),
    contact_name: String(args.contact_name ?? ""),
    to: String(args.to ?? "").trim().toLowerCase(),
    cc: Array.isArray(args.cc) ? args.cc.map((value) => String(value).trim().toLowerCase()).filter(Boolean) : [],
    subject: String(args.subject ?? ""),
    body: String(args.body ?? ""),
    schedule_date: String(args.schedule_date ?? ""),
    schedule_time: String(args.schedule_time ?? ""),
    timezone: String(args.timezone ?? "Asia/Kolkata"),
    preserve_signature: true,
    new_tasks: Array.isArray(args.new_tasks)
      ? args.new_tasks.map((task) => ({
          subject: String((task as Record<string, unknown>).subject ?? ""),
          due_date: String((task as Record<string, unknown>).due_date ?? "")
        }))
      : [],
    tasks_to_complete: Array.isArray(args.tasks_to_complete)
      ? args.tasks_to_complete.map((task) => ({ subject: String((task as Record<string, unknown>).subject ?? "") }))
      : []
  };
}

function zohoDisplayDate(isoDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return "";
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    Number(match[2]) - 1
  ];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : "";
}

function scheduleParts(raw: string) {
  const value = raw.trim().toUpperCase();
  const twelveHour = /^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/.exec(value);
  if (twelveHour) {
    return { hour: String(Number(twelveHour[1])), minute: twelveHour[2], ampm: twelveHour[3] };
  }
  const twentyFourHour = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (!twentyFourHour) return null;
  const hour24 = Number(twentyFourHour[1]);
  return {
    hour: String(hour24 % 12 || 12),
    minute: twentyFourHour[2],
    ampm: hour24 >= 12 ? "PM" : "AM"
  };
}

async function inspectDealPage(tabId: number, args: EmailJobArgs) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (expectedId: string, expectedName: string) => {
      const started = Date.now();
      let observation = { url: location.href, title: document.title, id_matches: false, name_matches: false };
      while (Date.now() - started < 15000) {
        const title = document.title.replace(/\s+/g, " ").trim();
        const expected = expectedName.toLowerCase();
        const visibleIdentity = [...document.querySelectorAll("h1,h2,h3,[role='heading'],span,div")].some((element) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          return rect.width > 0 && rect.height > 0 && text === expected;
        });
        observation = {
          url: location.href,
          title,
          id_matches: location.href.includes(`/tab/Potentials/${expectedId}`),
          name_matches: title.toLowerCase().includes(expected) || visibleIdentity
        };
        if (observation.id_matches && observation.name_matches) return observation;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return observation;
    },
    args: [args.deal_zoho_id, args.deal_name]
  });
  return results?.[0]?.result as
    | { url: string; title: string; id_matches: boolean; name_matches: boolean }
    | undefined;
}

async function prepareDealTasksWithApi(tabId: number, args: EmailJobArgs, requestId: string) {
  if (args.new_tasks.length === 0 && args.tasks_to_complete.length === 0) {
    return { ok: true as const, result: { created: [], already_open: [], completed: [], verified: true } };
  }
  let lastResult: Awaited<ReturnType<typeof zohoWritePageRunner>> | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: zohoWritePageRunner,
      args: [
        {
          tool_name: "zoho_prepare_tasks",
          args: {
            request_id: requestId,
            deal_zoho_id: args.deal_zoho_id,
            deal_name: args.deal_name,
            contact_zoho_id: args.contact_zoho_id,
            new_tasks: args.new_tasks,
            tasks_to_complete: args.tasks_to_complete
          }
        }
      ]
    });
    lastResult = results?.[0]?.result as Awaited<ReturnType<typeof zohoWritePageRunner>> | undefined;
    const payload = lastResult && !lastResult.ok && lastResult.result && typeof lastResult.result === "object"
      ? (lastResult.result as { receipts?: Array<{ status?: string }> })
      : null;
    const recoverableReceipt = payload?.receipts?.some((receipt) => receipt.status === "write_ok_unverified") === true;
    const missingOrUnserialized = !lastResult || (!lastResult.ok && lastResult.error_code === "receipt_serialize_failed");
    if (!missingOrUnserialized && !recoverableReceipt) return lastResult;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return lastResult ?? {
    ok: false,
    error_code: "task_receipt_missing",
    error_message: "Task writes may have succeeded, but the extension returned no receipt after deterministic adoption recovery.",
    result: { request_id: requestId, recovery_attempts: 2 }
  };
}

async function clearComposerAddresses(tabId: number) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      for (const selector of [
        '[id^="ceToAddrDetails"] li.selectedEmail .closeIconB',
        '[id^="ceCCAddrDetails"] li.selectedEmail .closeIconB'
      ]) {
        for (const close of [...document.querySelectorAll(selector)]) {
          if (close instanceof HTMLElement) close.click();
        }
      }
      for (const input of document.querySelectorAll("[id^='ceToAddr_'],[id^='ceCCAddr_']")) {
        if (input instanceof HTMLInputElement) input.value = "";
      }
      return { cleared: true };
    }
  });
  return results?.[0]?.result as { cleared?: boolean } | undefined;
}

async function revealCcInput(tabId: number) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      function ccInput() {
        const matches = [...document.querySelectorAll("[id^='ceCCAddr_']")];
        return matches.find((element) => element.getBoundingClientRect().width > 0) ?? matches[matches.length - 1] ?? null;
      }
      const input = ccInput();
      if (input instanceof HTMLElement && input.getBoundingClientRect().width > 0) return { visible: true };
      const candidates = [...document.querySelectorAll("a,button,span,div")].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (element.textContent ?? "").trim() === "Cc";
      });
      const candidate = candidates.find((element) => element.closest('[role="dialog"],.lyteModal,.modal')) ?? candidates[0];
      if (candidate instanceof HTMLElement) candidate.click();
      const next = ccInput();
      return { visible: next instanceof HTMLElement && next.getBoundingClientRect().width > 0 };
    }
  });
  return results?.[0]?.result as { visible?: boolean } | undefined;
}

async function setComposerContent(tabId: number, args: EmailJobArgs) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (subject: string, body: string) => {
      const subjectMatches = [...document.querySelectorAll("[id^='ceSubject_']")];
      const subjectInput =
        subjectMatches.find((element) => element.getBoundingClientRect().width > 0) ??
        subjectMatches[subjectMatches.length - 1] ??
        null;
      const frame = document.getElementById("z_editor");
      if (!(subjectInput instanceof HTMLInputElement)) throw new Error("Composer subject field is missing.");
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) throw new Error("Composer body frame is missing.");
      const frameDocument = frame.contentDocument;
      const editor = frameDocument.getElementById("editorDiv");
      const signature = frameDocument.getElementById("ecw_signature");
      if (!editor || !signature || !editor.contains(signature)) throw new Error("Composer signature is missing.");

      subjectInput.focus();
      subjectInput.value = subject;
      subjectInput.dispatchEvent(new Event("input", { bubbles: true }));
      subjectInput.dispatchEvent(new Event("change", { bubbles: true }));

      let signatureAnchor = signature;
      while (signatureAnchor.parentElement && signatureAnchor.parentElement !== editor) {
        signatureAnchor = signatureAnchor.parentElement;
      }
      if (signatureAnchor.parentElement !== editor) throw new Error("Signature anchor is outside the editor.");
      for (const node of [...editor.childNodes]) {
        if (node === signatureAnchor) break;
        node.remove();
      }

      const lines = body.replace(/\r\n/g, "\n").split("\n");
      while (lines[0]?.trim() === "") lines.shift();
      while (lines.at(-1)?.trim() === "") lines.pop();
      const container = frameDocument.createElement("div");
      const style = "font-family: Verdana, Geneva, sans-serif; font-size: 13.33px;";
      for (const line of lines) {
        const div = frameDocument.createElement("div");
        div.style.cssText = style;
        if (line === "") div.appendChild(frameDocument.createElement("br"));
        else div.textContent = line;
        container.appendChild(div);
      }
      for (let index = 0; index < 2; index += 1) {
        const spacer = frameDocument.createElement("div");
        spacer.style.cssText = style;
        spacer.appendChild(frameDocument.createElement("br"));
        container.appendChild(spacer);
      }
      editor.insertBefore(container, signatureAnchor);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        subject: subjectInput.value,
        body_text: container.innerText,
        first_body_line: lines.find((line) => line.trim()) ?? "",
        signature_present: signature.isConnected && editor.contains(signature),
        signature_after_body: Boolean(container.compareDocumentPosition(signature) & Node.DOCUMENT_POSITION_FOLLOWING)
      };
    },
    args: [args.subject, args.body]
  });
  return results?.[0]?.result as
    | {
        subject: string;
        body_text: string;
        first_body_line: string;
        signature_present: boolean;
        signature_after_body: boolean;
      }
    | undefined;
}

async function readComposerVerification(tabId: number) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      function chipEmails(selector: string) {
        return [...document.querySelectorAll(selector)]
          .map((element) => (element.getAttribute("email") || element.getAttribute("title") || "").trim().toLowerCase())
          .filter(Boolean);
      }
      const frame = document.getElementById("z_editor");
      const frameDocument = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
      const editor = frameDocument?.getElementById("editorDiv") ?? null;
      const signature = frameDocument?.getElementById("ecw_signature") ?? null;
      function fieldValue(selector: string) {
        const matches = [...document.querySelectorAll(selector)] as HTMLInputElement[];
        const visible = matches.filter((element) => element.getBoundingClientRect().width > 0);
        const input = visible[visible.length - 1] ?? matches[matches.length - 1] ?? null;
        return input?.value ?? "";
      }
      return {
        to: chipEmails('[id^="ceToAddrDetails"] li.selectedEmail'),
        cc: chipEmails('[id^="ceCCAddrDetails"] li.selectedEmail'),
        to_input: fieldValue("[id^='ceToAddr_']"),
        cc_input: fieldValue("[id^='ceCCAddr_']"),
        subject: fieldValue("[id^='ceSubject_']"),
        body_text: editor?.innerText ?? "",
        signature_present: Boolean(signature && editor?.contains(signature))
      };
    }
  });
  return results?.[0]?.result as
    | { to: string[]; cc: string[]; to_input: string; cc_input: string; subject: string; body_text: string; signature_present: boolean }
    | undefined;
}

async function configureAndSubmitSchedule(tabId: number, date: string, time: ReturnType<typeof scheduleParts>, timezone: string) {
  if (!time) return null;
  const displayDate = zohoDisplayDate(date);
  const timezoneValue = timezone === "Asia/Kolkata" ? "Asia/Calcutta" : timezone;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (expectedDate: string, hour: string, minute: string, ampm: string, expectedTimezone: string) => {
      const root = document.getElementById("etSchedulePopId");
      if (!root) throw new Error("Schedule popup is missing.");
      const custom = root.querySelector("#ecSchduleTime");
      if (custom instanceof HTMLInputElement) custom.checked = true;
      const dateInput = root.querySelector("#startDate");
      if (dateInput instanceof HTMLInputElement) {
        dateInput.value = expectedDate;
        dateInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const timeInput = root.querySelector("#schTimeMail");
      if (timeInput instanceof HTMLInputElement) {
        timeInput.value = `${hour.padStart(2, "0")}:${minute}`;
        timeInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const hourInput = root.querySelector('input[name="startDatehour"]');
      const minuteInput = root.querySelector("#startDateminute");
      const ampmInput = root.querySelector("#startDateampm");
      const timezoneInput = root.querySelector("#timeZone");
      if (hourInput instanceof HTMLInputElement) hourInput.value = hour;
      if (minuteInput instanceof HTMLInputElement) minuteInput.value = minute;
      if (ampmInput instanceof HTMLInputElement) ampmInput.value = ampm;
      if (timezoneInput instanceof HTMLInputElement || timezoneInput instanceof HTMLSelectElement) {
        timezoneInput.value = expectedTimezone;
        timezoneInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const confirm = [...root.querySelectorAll("button,span,a,div,input")].find(
        (element) => ((element.textContent || (element as HTMLInputElement).value || "").trim() === "Schedule & Close")
      );
      if (!(confirm instanceof HTMLElement)) throw new Error("Schedule & Close button is missing.");
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const popup = document.getElementById("etSchedulePopId");
      return {
        date: dateInput instanceof HTMLInputElement ? dateInput.value : "",
        time: `${hour}:${minute} ${ampm}`,
        timezone: expectedTimezone,
        popup_still_open: Boolean(popup && !popup.className.includes("hide")),
        composer_open: Boolean(document.querySelector("[id^='ceSubject_']")),
        success_text: [...document.querySelectorAll("body *")]
          .map((element) => (element.textContent ?? "").trim())
          .find((text) => /mail has been scheduled successfully/i.test(text)) ?? ""
      };
    },
    args: [displayDate, time.hour, time.minute, time.ampm, timezoneValue]
  });
  return results?.[0]?.result as
    | { date: string; time: string; timezone: string; popup_still_open: boolean; composer_open: boolean; success_text: string }
    | undefined;
}

async function verifyScheduledRow(tabId: number, args: EmailJobArgs) {
  const displayDate = zohoDisplayDate(args.schedule_date);
  const time = scheduleParts(args.schedule_time);
  const expectedTime = time ? `${time.hour.padStart(2, "0")}:${time.minute} ${time.ampm}` : args.schedule_time;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (subject: string, email: string, contactName: string, date: string, scheduleTime: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const bodyText = document.body.innerText.replace(/\s+/g, " ");
      const subjectFound = bodyText.includes(subject);
      const recipientFound = bodyText.toLowerCase().includes(email.toLowerCase()) || bodyText.includes(contactName);
      const dateFound = bodyText.includes(date);
      const timeFound = bodyText.toUpperCase().includes(scheduleTime.toUpperCase());
      const scheduledFound = /\bScheduled\b/i.test(bodyText);
      return { subject_found: subjectFound, recipient_found: recipientFound, date_found: dateFound, time_found: timeFound, scheduled_found: scheduledFound };
    },
    args: [args.subject, args.to, args.contact_name, displayDate, expectedTime]
  });
  return results?.[0]?.result as
    | { subject_found: boolean; recipient_found: boolean; date_found: boolean; time_found: boolean; scheduled_found: boolean }
    | undefined;
}

function sameEmails(actual: string[], expected: string[]) {
  const left = [...new Set(actual.map((value) => value.toLowerCase()))].sort();
  const right = [...new Set(expected.map((value) => value.toLowerCase()))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function runScheduleZohoEmail(tabId: number, job: ToolJob): Promise<PageResult> {
  const args = emailJobArgs(job.args);
  const started = Date.now();
  const timings: Record<string, number> = {};
  const mark = (name: string, phaseStarted: number) => {
    timings[name] = Date.now() - phaseStarted;
  };
  const fail = async (code: string, message: string, result: Record<string, unknown> = {}): Promise<PageResult> => ({
    ok: false,
    error_code: code,
    error_message: message,
    result: { reference: args.reference, deal_url: args.deal_url, timings_ms: timings, ...result, evidence: await captureEvidence(tabId) }
  });

  if (!isCrmUrl(args.deal_url) || !args.deal_zoho_id || !args.to || !args.subject || !args.body) {
    return fail("INVALID_EMAIL_JOB", "Resolved email job is missing required fields.");
  }

  let phaseStarted = Date.now();
  const opened = await executeUiStep(tabId, { type: "open_url", url: args.deal_url });
  if (!opened.ok) return fail("DEAL_NAVIGATION_FAILED", opened.error_message ?? "Could not open deal.");
  const deal = await inspectDealPage(tabId, args);
  mark("open_deal", phaseStarted);
  if (!deal?.id_matches || !deal.name_matches) {
    return fail("DEAL_IDENTITY_MISMATCH", "Loaded deal did not match the resolved deal.", { observed_deal: deal });
  }

  phaseStarted = Date.now();
  let taskPreparation: Awaited<ReturnType<typeof prepareDealTasksWithApi>>;
  try {
    taskPreparation = await prepareDealTasksWithApi(tabId, args, job.id);
  } catch (error) {
    return fail("TASK_PREPARATION_FAILED", error instanceof Error ? error.message : "Task preparation failed.");
  }
  mark("prepare_tasks", phaseStarted);
  if (!taskPreparation?.ok) {
    return fail(
      "TASK_PREPARATION_FAILED",
      taskPreparation?.error_message ?? "Task preparation returned no verification.",
      { task_preparation: taskPreparation?.result }
    );
  }

  phaseStarted = Date.now();
  let compose = await executeUiStep(tabId, { type: "click", selector: 'button[aria-label="Send Email"]' });
  let composerReady = compose.ok
    ? await executeUiStep(tabId, { type: "wait_for", selector: "[id^='ceToAddr_']", timeout_ms: 10000 })
    : compose;
  if (!composerReady.ok) {
    compose = await executeUiStep(tabId, { type: "click", text: "Compose Email" });
    composerReady = compose.ok
      ? await executeUiStep(tabId, { type: "wait_for", selector: "[id^='ceToAddr_']", timeout_ms: 10000 })
      : compose;
  }
  if (!composerReady.ok) return fail("COMPOSER_OPEN_FAILED", composerReady.error_message ?? "Composer did not open.");
  await clearComposerAddresses(tabId);

  const toFill = await executeUiStep(tabId, {
    type: "fill_field",
    selector: "[id^='ceToAddr_']",
    value: args.to,
    press_enter: true
  });
  if (!toFill.ok) return fail("TO_COMMIT_FAILED", toFill.error_message ?? "Could not commit recipient chip.");
  await new Promise((resolve) => setTimeout(resolve, 350));

  if (args.cc.length > 0) {
    const revealed = await revealCcInput(tabId);
    if (!revealed?.visible) return fail("CC_REVEAL_FAILED", "Could not reveal the scoped CC input.");
    for (const cc of args.cc) {
      const ccFill = await executeUiStep(tabId, {
        type: "fill_field",
        selector: "[id^='ceCCAddr_']",
        value: cc,
        press_enter: true
      });
      if (!ccFill.ok) return fail("CC_COMMIT_FAILED", ccFill.error_message ?? `Could not commit CC ${cc}.`);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  const content = await setComposerContent(tabId, args);
  const draft = await readComposerVerification(tabId);
  mark("compose_and_verify", phaseStarted);
  if (!content || !draft) return fail("DRAFT_READBACK_FAILED", "Composer read-back returned no result.");
  if (!sameEmails(draft.to, [args.to]) || draft.to_input.trim()) {
    return fail("TO_MISMATCH", "Committed To chips did not exactly match the resolved recipient.", { draft });
  }
  if (!sameEmails(draft.cc, args.cc) || draft.cc_input.trim()) {
    return fail("CC_MISMATCH", "Committed CC chips did not exactly match the draft CC list.", { draft });
  }
  if (draft.subject !== args.subject) return fail("SUBJECT_MISMATCH", "Subject read-back did not match.", { draft });
  if (!content.signature_present || !content.signature_after_body || !draft.signature_present) {
    return fail("SIGNATURE_MISSING", "Existing Zoho signature was not preserved after the body.", { draft, content });
  }

  phaseStarted = Date.now();
  const scheduleClick = await executeUiStep(tabId, { type: "click", text: "Schedule" });
  if (!scheduleClick.ok) return fail("SCHEDULE_OPEN_FAILED", scheduleClick.error_message ?? "Could not click Schedule.");
  const scheduleReady = await executeUiStep(tabId, { type: "wait_for", selector: "#etSchedulePopId", timeout_ms: 8000 });
  if (!scheduleReady.ok) return fail("SCHEDULE_POPUP_MISSING", scheduleReady.error_message ?? "Schedule popup did not open.");
  const schedule = await configureAndSubmitSchedule(tabId, args.schedule_date, scheduleParts(args.schedule_time), args.timezone);
  mark("schedule_submit", phaseStarted);
  if (!schedule || schedule.popup_still_open) {
    return fail("SCHEDULE_UNCONFIRMED", "Schedule & Close did not produce a confirmed close state. Submission was not retried.", {
      schedule
    });
  }

  phaseStarted = Date.now();
  const scheduledTab = await executeUiStep(tabId, { type: "click", text: "Scheduled" });
  if (!scheduledTab.ok) return fail("SCHEDULED_TAB_FAILED", scheduledTab.error_message ?? "Could not open Scheduled tab.");
  const verification = await verifyScheduledRow(tabId, args);
  mark("scheduled_readback", phaseStarted);
  const verified = Boolean(
    verification?.subject_found &&
      verification.recipient_found &&
      verification.date_found &&
      verification.time_found &&
      verification.scheduled_found
  );
  if (!verified) return fail("SCHEDULED_ROW_MISMATCH", "Scheduled-tab read-back did not match every required value.", { verification });

  timings.total = Date.now() - started;
  return {
    ok: true,
    result: {
      ok: true,
      status: "scheduled",
      reference: args.reference,
      deal: { id: args.deal_zoho_id, name: args.deal_name, url: args.deal_url },
      draft_verification: {
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        first_body_line: content.first_body_line,
        signature_preserved: true
      },
      schedule_verification: {
        date: args.schedule_date,
        time: args.schedule_time,
        timezone: args.timezone,
        row_found: true,
        status: "Scheduled"
      },
      task_verification: taskPreparation,
      timings_ms: timings,
      evidence: await captureEvidence(tabId)
    }
  };
}

// Runs the read-only executor in the page's MAIN world via chrome.scripting.
// Inline <script> injection is blocked by Zoho's CSP; executeScript is not.
async function executeInTab(tabId: number, job: ToolJob): Promise<PageResult> {
  const isWrite = WRITE_TOOLS.has(job.tool_name);
  if (job.tool_name === "schedule_zoho_email") {
    return runScheduleZohoEmail(tabId, job);
  }
  if (job.tool_name === "ui_step") {
    return executeUiStep(tabId, (job.args.step ?? {}) as Record<string, unknown>);
  }
  if (job.tool_name === "ui_workflow") return runUiWorkflow(tabId, job);
  if (job.tool_name === "browser_observe") {
    const crmError = await assertCrmTab(tabId);
    if (crmError) return crmError;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: browserObservePageRunner,
        args: [{ args: job.args }]
      });
      const result = results?.[0]?.result as PageResult | undefined;
      if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
        return { ok: false, error_message: "browser_observe returned no result." };
      }
      if (result.ok) {
        await cacheBrowserSnapshot(tabId, result.result);
        return { ...result, result: compactBrowserObservation(result.result) };
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        error_message: `Could not observe the Zoho tab${error instanceof Error ? `: ${error.message}` : ""}.`
      };
    }
  }
  if (job.tool_name === "browser_eval") {
    const crmError = await assertCrmTab(tabId);
    if (crmError) return crmError;
    const composerMark = await composerMutationMark(tabId, job);
    const code = typeof job.args.code === "string" ? job.args.code : "";
    if (looksLikeSendNowEndpoint(code)) {
      return { ok: false, error_message: SEND_NOW_BLOCKED_MESSAGE, result: { send_now_blocked: true } };
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: browserEvalPageRunner,
        args: [{ args: job.args }]
      });
      const result = results?.[0]?.result as PageResult | undefined;
      if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
        return { ok: false, error_message: "browser_eval returned no result." };
      }
      return withComposerGateResult(result, composerMark);
    } catch (error) {
      return {
        ok: false,
        error_message: `Could not run browser_eval in the Zoho tab${error instanceof Error ? `: ${error.message}` : ""}.`
      };
    }
  }
  if (job.tool_name === "browser_navigate") {
    return executeUiStep(tabId, { type: "open_url", url: job.args.url });
  }
  if (job.tool_name === "browser_screenshot") {
    const crmError = await assertCrmTab(tabId);
    if (crmError) return crmError;
    return { ok: true, result: await captureEvidence(tabId) };
  }
  if (job.tool_name === "browser_input") {
    const crmError = await assertCrmTab(tabId);
    if (crmError) return crmError;
    const composerMark = await composerMutationMark(tabId, job);
    const action = String(job.args.action ?? "");
    const resolved = await resolveBrowserSnapshotRef(tabId, job.args);
    if (!resolved.ok) return resolved.response;
    const target = resolved.target;
    const targetArgs = {
      ref: target.ref,
      snapshot_id: target.snapshot_id,
      selector: target.selector,
      alternative_selectors: target.alternative_selectors,
      text: target.text,
      frame_selector: target.frame_selector,
      frame_selectors: target.frame_selectors
    };
    // Snapshot refs flagged hidden_until_hover point at chip remove controls
    // that only render while their container is hovered. Route them through
    // the hover-first remove flow against the visible container instead of
    // clicking an invisible element.
    const hiddenUntilHover = target.hidden_until_hover === true;
    const containerSelector = typeof target.container_selector === "string" ? target.container_selector : "";
    const hoverFirstArgs =
      hiddenUntilHover && containerSelector
        ? { ...targetArgs, selector: containerSelector, alternative_selectors: [] }
        : null;
    if (action === "click") {
      const result = hoverFirstArgs
        ? await executeUiStep(tabId, { type: "remove_item", ...hoverFirstArgs })
        : await executeUiStep(tabId, { type: "click", ...targetArgs });
      return withComposerGateResult(result, composerMark);
    }
    if (action === "type") {
      const result = await executeUiStep(tabId, {
        type: "fill_field",
        ...targetArgs,
        value: job.args.value,
        press_enter: job.args.press_enter
      });
      return withComposerGateResult(result, composerMark);
    }
    if (action === "key") {
      const result = await executeUiStep(tabId, {
        type: "press_key",
        key: job.args.key,
        repeat: job.args.repeat,
        ...targetArgs
      });
      return withComposerGateResult(result, composerMark);
    }
    if (action === "remove") {
      const result = await executeUiStep(tabId, {
        type: "remove_item",
        ...(hoverFirstArgs ?? targetArgs)
      });
      return withComposerGateResult(result, composerMark);
    }
    if (action === "hover" || action === "focus") {
      const result = await executeUiStep(tabId, { type: action, ...targetArgs });
      return withComposerGateResult(result, composerMark);
    }
    if (action === "clear") {
      const result = await executeUiStep(tabId, { type: "fill_field", ...targetArgs, value: "" });
      return withComposerGateResult(result, composerMark);
    }
    if (action === "select") {
      const result = await executeUiStep(tabId, { type: "select_field", ...targetArgs, value: job.args.value });
      return withComposerGateResult(result, composerMark);
    }
    if (action === "check" || action === "uncheck") {
      const result = await executeUiStep(tabId, { type: "set_checked", ...targetArgs, checked: action === "check" });
      return withComposerGateResult(result, composerMark);
    }
    return { ok: false, error_message: "Unsupported browser_input action." };
  }
  if (job.tool_name === "zoho_api") {
    const crmError = await assertCrmTab(tabId);
    if (crmError) return crmError;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: zohoApiPageRunner,
        args: [{ tool_name: job.tool_name, args: job.args }]
      });
      const result = results?.[0]?.result as PageResult | undefined;
      if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
        return { ok: false, error_message: "zoho_api returned no result." };
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        error_message: `Could not run zoho_api in the Zoho tab${error instanceof Error ? `: ${error.message}` : ""}.`
      };
    }
  }

  const crmError = await assertCrmTab(tabId);
  if (crmError) return crmError;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: isWrite ? zohoWritePageRunner : zohoPageRunner,
      args: [{ tool_name: job.tool_name, args: job.args }]
    });
    const result = results?.[0]?.result as PageResult | undefined;
    if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") {
      return {
        ok: false,
        error_message: "Zoho page executor returned no result (the tab may still be loading). Try again."
      };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      error_message: `Could not run in the Zoho tab${
        error instanceof Error ? `: ${error.message}` : ""
      }. If the extension was just reloaded, refresh the crm.zoho.com tab and try again.`
    };
  }
}

async function pollOnce() {
  if (inFlight) return;
  const settings = await loadSettings();
  if (!settings.enabled) return;

  inFlight = true;
  try {
    const claimed = await claimJob(settings);
    await runClaimedJob(settings, claimed);
  } finally {
    inFlight = false;
  }
}

async function claimAndRunRealtimeJob() {
  if (inFlight) return;
  const settings = await loadSettings();
  if (!settings.enabled) return;

  inFlight = true;
  try {
    const claimed = await claimJob(settings);
    await runClaimedJob(settings, claimed);
  } catch (error) {
    await saveLastJobStatus(error instanceof Error ? `Realtime job pickup failed: ${error.message}` : "Realtime job pickup failed.");
  } finally {
    inFlight = false;
  }
}

// A claimed job must ALWAYS report a terminal result: if the extension
// claims a job and then crashes, hangs, or cannot deliver the report, the
// backend waits out its full timeout and surfaces "picked this job up but
// never reported a result". Guard all three failure modes:
// - watchdog: bound executeInTab below the backend's 90s job timeout;
// - crash: catch every throw between claim and report;
// - delivery: retry the report POST (the Next.js server may be restarting).
const EXECUTE_WATCHDOG_MS = 75 * 1000;
const REPORT_RETRY_DELAYS_MS = [0, 2000, 5000];

async function reportWithRetry(run: () => Promise<unknown>) {
  let lastError: unknown = null;
  for (const delay of REPORT_RETRY_DELAYS_MS) {
    if (delay) await sleep(delay);
    try {
      await run();
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn("[agent-jobs] Report delivery failed after retries.", lastError);
  return false;
}

async function runClaimedJob(settings: Awaited<ReturnType<typeof loadSettings>>, claimed: JobClaimResponse) {
  if (!claimed.job) {
    idleSince = idleSince || Date.now();
    return;
  }

  idleSince = 0;
  const job = claimed.job;
  await saveLastJobStatus(`Claimed ${job.tool_name} (${job.id}).`);

  let response: PageResult;
  try {
    // Tab check AFTER claim: a missing CRM tab now reports an actionable
    // failure within seconds instead of leaving the job queued until the
    // backend's 90s wait expires.
    const tab = await crmTabForJob(job);
    if (!tab?.id) {
      response = {
        ok: false,
        error_message:
          "Could not open a dedicated crm.zoho.com window in this Chrome profile. Open Zoho CRM in a tab and ask again."
      };
    } else {
      await saveLastJobStatus(`Running ${job.tool_name} in dedicated Chrome window tab ${tab.id}.`);
      response = await Promise.race([
        executeInTab(tab.id, job),
        sleep(EXECUTE_WATCHDOG_MS).then(
          (): PageResult => ({
            ok: false,
            error_message: `${job.tool_name} did not finish within ${Math.round(
              EXECUTE_WATCHDOG_MS / 1000
            )}s inside the extension. The Zoho tab may be stuck; refresh the crm.zoho.com tab and try again.`
          })
        )
      ]);
    }
  } catch (error) {
    response = {
      ok: false,
      error_message: `Extension job crashed: ${error instanceof Error ? error.message : "unknown error"}.`
    };
  }

  const delivered = response.ok
    ? await reportWithRetry(() => reportJobDone(settings, job.id, response.result ?? null))
    : await reportWithRetry(() =>
        reportJobFailed(settings, job.id, response.error_message ?? "Zoho job failed.", response.error_code, response.result)
      );

  if (response.ok) {
    await saveLastJobStatus(
      delivered
        ? `Completed ${job.tool_name} (${job.id}).`
        : `Completed ${job.tool_name} (${job.id}) but could not deliver the result to the backend.`
    );
  } else {
    await saveLastJobStatus(
      `Failed ${job.tool_name}: ${response.error_message ?? "unknown error"}${delivered ? "" : " (report delivery also failed)"}`
    );
  }
}

function scheduleNext() {
  const idleFor = idleSince ? Date.now() - idleSince : 0;
  const delay = idleFor > IDLE_BACKOFF_AFTER_MS ? IDLE_POLL_MS : ACTIVE_POLL_MS;
  timer = setTimeout(loop, delay) as unknown as number;
}

async function loop() {
  try {
    await pollOnce();
  } catch (error) {
    await saveLastJobStatus(error instanceof Error ? error.message : "Agent job poll failed.");
  } finally {
    scheduleNext();
  }
}

function scheduleStreamNext(delayMs = STREAM_RECONNECT_MS) {
  streamTimer = setTimeout(streamLoop, delayMs) as unknown as number;
}

function scheduleRealtimeReconnect(delayMs = REALTIME_RECONNECT_MS) {
  if (realtimeTimer !== undefined) clearTimeout(realtimeTimer);
  realtimeTimer = setTimeout(() => {
    realtimeTimer = undefined;
    void connectRealtimeJobs();
  }, delayMs) as unknown as number;
}

async function disconnectRealtimeJobs() {
  if (realtimeChannel && realtimeClient) {
    await realtimeClient.removeChannel(realtimeChannel);
  }
  realtimeChannel = null;
  realtimeClient = null;
}

async function connectRealtimeJobs() {
  if (realtimeStarting || realtimeChannel) return;
  realtimeStarting = true;
  try {
    const settings = await loadSettings();
    if (!settings.enabled) {
      scheduleRealtimeReconnect(IDLE_POLL_MS);
      return;
    }

    const config = await realtimeConfig(settings);
    const client = createClient(config.supabase_url, config.supabase_anon_key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const channel = client
      .channel(config.channel, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "job_inserted" }, (event) => {
        const payload = event.payload as { user_id?: unknown; job_id?: unknown };
        if (payload.user_id !== config.user_id || typeof payload.job_id !== "string") return;
        void claimAndRunRealtimeJob();
      });

    realtimeClient = client;
    realtimeChannel = channel;
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void saveLastJobStatus("Realtime job channel connected.");
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        void saveLastJobStatus(`Realtime job channel ${status.toLowerCase()}; using fallback polling/stream.`);
        void disconnectRealtimeJobs().finally(() => scheduleRealtimeReconnect());
      }
    });
  } catch (error) {
    await saveLastJobStatus(error instanceof Error ? `Realtime job channel unavailable: ${error.message}` : "Realtime job channel unavailable.");
    scheduleRealtimeReconnect();
  } finally {
    realtimeStarting = false;
  }
}

async function streamLoop() {
  if (streamInFlight) return;
  const settings = await loadSettings();
  if (!settings.enabled) {
    scheduleStreamNext(IDLE_POLL_MS);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  streamInFlight = true;
  try {
    const claimed = await streamJob(settings, controller.signal);
    if (claimed.job) {
      while (inFlight) {
        await sleep(250);
      }
      inFlight = true;
      try {
        await runClaimedJob(settings, claimed);
      } finally {
        inFlight = false;
      }
    }
  } catch (error) {
    await saveLastJobStatus(error instanceof Error ? `SSE job stream fallback: ${error.message}` : "SSE job stream fallback.");
  } finally {
    clearTimeout(timeout);
    streamInFlight = false;
    scheduleStreamNext();
  }
}

export function startJobStream() {
  if (streamTimer !== undefined) return;
  scheduleStreamNext(0);
}

export function startRealtimeJobs() {
  void connectRealtimeJobs();
}

export function startJobPolling() {
  if (timer !== undefined) return;
  idleSince = Date.now();
  scheduleNext();
}

export function pollAgentJobOnce() {
  return pollOnce();
}
