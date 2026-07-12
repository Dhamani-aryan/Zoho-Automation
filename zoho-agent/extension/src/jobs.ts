import { claimJob, reportJobDone, reportJobFailed, type ToolJob } from "./api";
import { zohoPageRunner, type PageResult } from "./page-runner";
import { zohoApiPageRunner } from "./page-runner-api";
import { zohoUiPageRunner } from "./page-runner-ui";
import { zohoWritePageRunner } from "./page-runner-write";
import { SEND_NOW_BLOCKED_MESSAGE, isModifierEnterKey, looksLikeSendNowEndpoint } from "./send-guard";
import { loadSettings, saveLastJobStatus } from "./storage";

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

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 15000;
const IDLE_BACKOFF_AFTER_MS = 5 * 60 * 1000;
const AGENT_WINDOW_HOME = "https://crm.zoho.com/crm/org890324941/tab/Potentials/custom-view/6834250000000087545/list";
const AGENT_WINDOW_KEYS = {
  agentWindowId: null as number | null,
  agentTabId: null as number | null,
  agentWindowDedicated: false
};

let inFlight = false;
let idleSince = Date.now();
let timer: number | undefined;

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
  const created = await chrome.windows.create({ url, focused: false, type: "normal" });
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
    function labelOf(element: Element) {
      const el = element as HTMLInputElement;
      return [
        element.textContent ?? "",
        el.value ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
        element.getAttribute("data-zcqa") ?? "",
        element.id ?? "",
        element.className ? String(element.className) : ""
      ]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }
    function isSendNowElement(target: EventTarget | null) {
      if (!(target instanceof Element)) return false;
      const candidate = target.closest("button,a,input,[role='button'],span,div");
      if (!candidate) return false;
      const label = labelOf(candidate);
      if (/\bschedule\b/i.test(label)) return false;
      return /\bsend\b/i.test(label);
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
    document.addEventListener("click", clickGuard, true);
    if (boundDocument !== document) boundDocument.addEventListener("click", clickGuard, true);
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
      if (boundDocument !== document) boundDocument.removeEventListener("click", clickGuard, true);
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

function browserObservePageRunner(input?: { args?: { scope_selector?: string } }) {
  const LIMIT = 16 * 1024;
  const scopeSelector = typeof input?.args?.scope_selector === "string" ? input.args.scope_selector.trim() : "";

  type ObserveContext = {
    doc: Document;
    root: ParentNode;
    frame: string;
    frameSelector: string | null;
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
    const name = el.getAttribute("name");
    if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria) return `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
    const role = el.getAttribute("role");
    if (role) return `${element.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
    return element.tagName.toLowerCase();
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
        offsetX: parent.offsetX + rect.left,
        offsetY: parent.offsetY + rect.top
      };
    } catch {
      return null;
    }
  }

  function collectContexts() {
    const contexts: ObserveContext[] = [
      { doc: document, root: document, frame: "main", frameSelector: null, offsetX: 0, offsetY: 0 }
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
            "#ceToAddr_1,#ceCCAddr_1,#ceSubject_1,#editorDiv,#ecw_signature,[id^='ceToAddrDetails'] li.selectedEmail,[id^='ceCCAddrDetails'] li.selectedEmail"
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

  function elementsAcrossContexts(selector: string) {
    return allContexts.flatMap((context) => Array.from(context.doc.querySelectorAll(selector)));
  }

  const subject = elementsAcrossContexts("#ceSubject_1")[0] ?? null;
  const toInput = elementsAcrossContexts("#ceToAddr_1")[0] ?? null;
  const ccInput = elementsAcrossContexts("#ceCCAddr_1")[0] ?? null;
  const editor = elementsAcrossContexts("#editorDiv")[0] ?? null;
  const signature = elementsAcrossContexts("#ecw_signature")[0] ?? null;
  const toChips = elementsAcrossContexts('[id^="ceToAddrDetails"] li.selectedEmail').map(textOf).filter(Boolean);
  const ccChips = elementsAcrossContexts('[id^="ceCCAddrDetails"] li.selectedEmail').map(textOf).filter(Boolean);
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
      truncated: true,
      preview: json.slice(0, LIMIT)
    }
  };
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
  | { ok: true; x: number; y: number; observed: string; tag_name: string }
  | { ok: false; error_message: string };

async function locateUiTarget(tabId: number, step: Record<string, unknown>): Promise<LocatedUiTarget> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (rawStep: Record<string, unknown>) => {
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
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
      function frameContext() {
        const frameSelector = typeof rawStep.frame_selector === "string" ? rawStep.frame_selector : "";
        if (!frameSelector) return { doc: document, offsetX: 0, offsetY: 0 };
        const frame = document.querySelector(frameSelector);
        if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) {
          return { error: `Frame was not found: ${frameSelector}` };
        }
        const rect = frame.getBoundingClientRect();
        return { doc: frame.contentDocument, offsetX: rect.left, offsetY: rect.top };
      }
      const ctx = frameContext();
      if ("error" in ctx) return { ok: false, error_message: ctx.error };

      const selector = typeof rawStep.selector === "string" ? rawStep.selector : "";
      const text = typeof rawStep.text === "string" ? rawStep.text.trim().toLowerCase() : "";
      let element: Element | null = null;
      if (selector) {
        const selected = ctx.doc.querySelector(selector);
        element = selected && isVisible(selected) ? selected : null;
      } else if (text) {
        const all = [...ctx.doc.querySelectorAll("button,a,input,textarea,[role='button'],span,div")].filter(isVisible);
        element =
          all.find((candidate) => textOf(candidate).toLowerCase() === text) ??
          all.find((candidate) => textOf(candidate).toLowerCase().includes(text)) ??
          null;
      }
      if (!element) return { ok: false, error_message: "UI target was not found." };
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
      const rect = element.getBoundingClientRect();
      return {
        ok: true,
        x: Math.round(ctx.offsetX + rect.left + rect.width / 2),
        y: Math.round(ctx.offsetY + rect.top + rect.height / 2),
        observed: valueOf(element),
        tag_name: element.tagName.toLowerCase()
      };
    },
    args: [step]
  });
  const located = results?.[0]?.result as LocatedUiTarget | undefined;
  return located ?? { ok: false, error_message: "UI locator returned no result." };
}

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
      function labelOf(element: Element) {
        const el = element as HTMLInputElement;
        return [
          element.textContent ?? "",
          el.value ?? "",
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("title") ?? "",
          element.getAttribute("data-zcqa") ?? "",
          element.id ?? "",
          element.className ? String(element.className) : ""
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
      const target = document.elementFromPoint(clientX, clientY);
      const candidate = target?.closest("button,a,input,[role='button'],span,div") ?? null;
      if (!candidate) return { blocked: false };
      const label = labelOf(candidate);
      if (/\bschedule\b/i.test(label)) return { blocked: false, label };
      return { blocked: /\bsend\b/i.test(label), label };
    },
    args: [x, y]
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
  return type === "click" || type === "fill_field" || type === "press_key";
}

async function runTrustedUiStep(tabId: number, step: Record<string, unknown>): Promise<PageResult> {
  const type = String(step.type ?? "");
  if (type === "press_key") {
    const key = String(step.key ?? "");
    if (isModifierEnterKey(key)) {
      return { ok: false, error_message: SEND_NOW_BLOCKED_MESSAGE, result: { send_now_blocked: true } };
    }
    await withDebugger(tabId, async (target) => {
      await dispatchTrustedKey(target, key);
    });
    return { ok: true, result: { observed: `trusted key ${key}`, input_method: "cdp", trusted: true } };
  }

  const located = await locateUiTarget(tabId, step);
  if (!located.ok) return { ok: false, error_message: located.error_message };
  if (type === "click") {
    const sendGuard = await assertSendGuardAllowsClick(tabId, located.x, located.y);
    if (sendGuard) return sendGuard;
  }

  return withDebugger(tabId, async (target) => {
    await dispatchTrustedClick(target, located.x, located.y);
    if (type === "fill_field") {
      await replaceFocusedText(target, String(step.value ?? ""));
      if (step.press_enter === true) await dispatchTrustedKey(target, "Enter");
      return {
        ok: true,
        result: {
          observed: String(step.value ?? ""),
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

  return null;
}

async function executeUiStep(tabId: number, step: Record<string, unknown>): Promise<PageResult> {
  try {
    const backgroundUiResult = await runBackgroundUiStep(tabId, step);
    if (backgroundUiResult) return backgroundUiResult;

    const crmError = await assertCrmTab(tabId);
    if (crmError) return crmError;

    if (usesTrustedInput(step)) {
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
      for (const id of ["ceToAddr_1", "ceCCAddr_1"]) {
        const input = document.getElementById(id);
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
      const input = document.getElementById("ceCCAddr_1");
      if (input instanceof HTMLElement && input.getBoundingClientRect().width > 0) return { visible: true };
      const candidates = [...document.querySelectorAll("a,button,span,div")].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (element.textContent ?? "").trim() === "Cc";
      });
      const candidate = candidates.find((element) => element.closest('[role="dialog"],.lyteModal,.modal')) ?? candidates[0];
      if (candidate instanceof HTMLElement) candidate.click();
      const next = document.getElementById("ceCCAddr_1");
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
      const subjectInput = document.getElementById("ceSubject_1");
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
      return {
        to: chipEmails('[id^="ceToAddrDetails"] li.selectedEmail'),
        cc: chipEmails('[id^="ceCCAddrDetails"] li.selectedEmail'),
        to_input: (document.getElementById("ceToAddr_1") as HTMLInputElement | null)?.value ?? "",
        cc_input: (document.getElementById("ceCCAddr_1") as HTMLInputElement | null)?.value ?? "",
        subject: (document.getElementById("ceSubject_1") as HTMLInputElement | null)?.value ?? "",
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
        composer_open: Boolean(document.getElementById("ceSubject_1")),
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
    ? await executeUiStep(tabId, { type: "wait_for", selector: "#ceToAddr_1", timeout_ms: 10000 })
    : compose;
  if (!composerReady.ok) {
    compose = await executeUiStep(tabId, { type: "click", text: "Compose Email" });
    composerReady = compose.ok
      ? await executeUiStep(tabId, { type: "wait_for", selector: "#ceToAddr_1", timeout_ms: 10000 })
      : compose;
  }
  if (!composerReady.ok) return fail("COMPOSER_OPEN_FAILED", composerReady.error_message ?? "Composer did not open.");
  await clearComposerAddresses(tabId);

  const toFill = await executeUiStep(tabId, {
    type: "fill_field",
    selector: "#ceToAddr_1",
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
        selector: "#ceCCAddr_1",
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
    if (!job.approval_id && !job.task_order_id) {
      return { ok: false, error_message: "write without approval or task order refused by extension" };
    }
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
      return result;
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
    const action = String(job.args.action ?? "");
    if (action === "click") {
      return executeUiStep(tabId, {
        type: "click",
        selector: job.args.selector,
        text: job.args.text,
        frame_selector: job.args.frame_selector
      });
    }
    if (action === "type") {
      return executeUiStep(tabId, {
        type: "fill_field",
        selector: job.args.selector,
        text: job.args.text,
        frame_selector: job.args.frame_selector,
        value: job.args.value,
        press_enter: job.args.press_enter
      });
    }
    if (action === "key") {
      return executeUiStep(tabId, { type: "press_key", key: job.args.key });
    }
    return { ok: false, error_message: "browser_input action must be click, type, or key." };
  }
  if (job.tool_name === "zoho_api") {
    const method = String(job.args.method ?? "").trim().toUpperCase();
    if (method !== "GET" && !job.approval_id && !job.task_order_id) {
      return { ok: false, error_message: "write without approval or task order refused by extension" };
    }
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

  // Belt-and-braces (3 of 3): a write job must carry an approval_id OR an
  // approved task_order_id from the server claim route. Even if the server
  // checks were somehow bypassed, the extension refuses unscoped writes.
  if (isWrite && !job.approval_id && !job.task_order_id) {
    return { ok: false, error_message: "write without approval or task order refused by extension" };
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
    if (!claimed.job) {
      idleSince = idleSince || Date.now();
      return;
    }

    idleSince = 0;
    await saveLastJobStatus(`Claimed ${claimed.job.tool_name} (${claimed.job.id}).`);

    // Tab check AFTER claim: a missing CRM tab now reports an actionable
    // failure within seconds instead of leaving the job queued until the
    // backend's 90s wait expires.
    const tab = await crmTabForJob(claimed.job);
    if (!tab?.id) {
      const message =
        "Could not open a dedicated crm.zoho.com window in this Chrome profile. Open Zoho CRM in a tab and ask again.";
      await reportJobFailed(settings, claimed.job.id, message);
      await saveLastJobStatus(`Failed ${claimed.job.tool_name}: no crm.zoho.com agent window.`);
      return;
    }

    await saveLastJobStatus(`Running ${claimed.job.tool_name} in dedicated Chrome window tab ${tab.id}.`);
    const response = await executeInTab(tab.id, claimed.job);

    if (response.ok) {
      await reportJobDone(settings, claimed.job.id, response.result ?? null);
      await saveLastJobStatus(`Completed ${claimed.job.tool_name} (${claimed.job.id}).`);
    } else {
      await reportJobFailed(
        settings,
        claimed.job.id,
        response.error_message ?? "Zoho job failed.",
        response.error_code,
        response.result
      );
      await saveLastJobStatus(`Failed ${claimed.job.tool_name}: ${response.error_message ?? "unknown error"}`);
    }
  } finally {
    inFlight = false;
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

export function startJobPolling() {
  if (timer !== undefined) return;
  idleSince = Date.now();
  scheduleNext();
}

export function pollAgentJobOnce() {
  return pollOnce();
}
