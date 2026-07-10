import { claimJob, reportJobDone, reportJobFailed, type ToolJob } from "./api";
import { zohoPageRunner, type PageResult } from "./page-runner";
import { zohoUiPageRunner } from "./page-runner-ui";
import { zohoWritePageRunner } from "./page-runner-write";
import { loadSettings, saveLastJobStatus } from "./storage";

// Tier-2 write tools. Kept in sync with lib/agent/tier2-tools.ts
// TIER2_WRITE_TOOL_NAMES; the lib-side extensionAcceptsWriteJob() encodes the
// same rule and is unit-tested.
const WRITE_TOOLS = new Set(["zoho_update_fields", "zoho_change_owner", "zoho_add_tags", "zoho_remove_tags"]);

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 15000;
const IDLE_BACKOFF_AFTER_MS = 5 * 60 * 1000;
const AGENT_WINDOW_HOME = "https://crm.zoho.com/crm/org890324941/tab/Potentials/custom-view/6834250000000087545/list";
const AGENT_WINDOW_KEYS = { agentWindowId: null as number | null, agentTabId: null as number | null };

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

function storedAgentTarget(): Promise<{ agentWindowId: number | null; agentTabId: number | null }> {
  return new Promise((resolve) => {
    chrome.storage.local.get(AGENT_WINDOW_KEYS, (items) => {
      resolve({
        agentWindowId: typeof items.agentWindowId === "number" ? items.agentWindowId : null,
        agentTabId: typeof items.agentTabId === "number" ? items.agentTabId : null
      });
    });
  });
}

function saveAgentTarget(agentWindowId: number | null, agentTabId: number | null): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ agentWindowId, agentTabId }, resolve);
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
  if (job.tool_name === "ui_step") {
    const step = (job.args.step ?? {}) as Record<string, unknown>;
    if (step.type === "open_url" && isCrmUrl(step.url)) return String(step.url);
  }
  if (job.tool_name === "ui_workflow") {
    const steps = Array.isArray(job.args.steps) ? (job.args.steps as Array<Record<string, unknown>>) : [];
    const firstOpen = steps.find((step) => step?.type === "open_url" && isCrmUrl(step.url));
    if (firstOpen) return String(firstOpen.url);
  }
  return AGENT_WINDOW_HOME;
}

async function usableStoredTab() {
  const stored = await storedAgentTarget();
  if (typeof stored.agentTabId !== "number") return null;
  try {
    const tab = await chrome.tabs.get(stored.agentTabId);
    if (typeof tab.id === "number" && isCrmUrl(tab.url)) return tab;
  } catch {
    // The user may have closed the dedicated window; create a fresh one below.
  }
  await saveAgentTarget(null, null);
  return null;
}

async function createAgentWindow(url: string, focus: boolean) {
  const created = await chrome.windows.create({ url, focused: focus, type: "normal" });
  const tab = created.tabs?.find((item) => typeof item.id === "number") ?? null;
  const tabId = tab?.id ?? null;
  await saveAgentTarget(created.id ?? null, tabId);
  if (tabId) await waitForTabComplete(tabId);
  return tabId ? await chrome.tabs.get(tabId) : null;
}

// UI jobs drive the visible page (and screenshots need the active tab of the
// focused window), so they focus the dedicated window. API session jobs only
// need SOME crm.zoho.com page context - they reuse a tab QUIETLY and never
// steal the user's focus mid-typing.
function isUiJob(job: ToolJob) {
  return job.tool_name === "ui_step" || job.tool_name === "ui_workflow";
}

async function focusTab(tab: chrome.tabs.Tab) {
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true, state: "normal" }).catch(() => undefined);
  }
  if (typeof tab.id === "number") await chrome.tabs.update(tab.id, { active: true });
}

async function crmTabForJob(job: ToolJob) {
  const focus = isUiJob(job);
  const stored = await usableStoredTab();
  if (stored?.id) {
    if (focus) await focusTab(stored);
    return stored;
  }

  if (focus) {
    // UI jobs: the dedicated window is the point - the user must always know
    // which page is being driven. Create it before falling back to arbitrary
    // existing tabs.
    const created = await createAgentWindow(initialUrlForJob(job), true);
    if (created?.id) return created;
  }

  // API jobs (and UI fallback if window creation failed): reuse any open CRM
  // tab quietly - no focus/activation, the session call runs in the background.
  const tabs = await crmTabs();
  const existing = tabs.find((tab) => typeof tab.id === "number") ?? null;
  if (existing?.id) {
    await saveAgentTarget(existing.windowId ?? null, existing.id);
    if (focus) await focusTab(existing);
    return existing;
  }

  // No CRM tab anywhere: open the dedicated window (quietly for API jobs).
  return createAgentWindow(initialUrlForJob(job), focus);
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

async function captureEvidence() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
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
    await withDebugger(tabId, async (target) => {
      await dispatchTrustedKey(target, key);
    });
    return { ok: true, result: { observed: `trusted key ${key}`, input_method: "cdp", trusted: true } };
  }

  const located = await locateUiTarget(tabId, step);
  if (!located.ok) return { ok: false, error_message: located.error_message };

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
    await chrome.tabs.update(tabId, { url: parsed.toString(), active: true });
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

// Step types that can mutate CRM state. Kept in sync with the server-side
// save-time classification in lib/agent/ui-tools.ts stepLooksMutating().
const MUTATING_UI_STEPS = new Set(["click", "fill_field", "press_key"]);

async function runUiWorkflow(tabId: number, job: ToolJob): Promise<PageResult> {
  const steps = Array.isArray(job.args.steps) ? (job.args.steps as Array<Record<string, unknown>>) : [];
  // Refuse unapproved replays when EITHER the declared effect is write OR any
  // step could mutate state (defense in depth: do not trust the effect label
  // alone if the two ever disagree).
  const hasMutatingStep = steps.some((step) => MUTATING_UI_STEPS.has(String(step?.type ?? "")));
  if ((job.args.effect === "write" || hasMutatingStep) && !job.approval_id && !job.task_order_id) {
    return { ok: false, error_message: "write workflow without approval or task order refused by extension" };
  }

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

// Runs the read-only executor in the page's MAIN world via chrome.scripting.
// Inline <script> injection is blocked by Zoho's CSP; executeScript is not.
async function executeInTab(tabId: number, job: ToolJob): Promise<PageResult> {
  const isWrite = WRITE_TOOLS.has(job.tool_name);
  if (job.tool_name === "ui_step") return executeUiStep(tabId, (job.args.step ?? {}) as Record<string, unknown>);
  if (job.tool_name === "ui_workflow") return runUiWorkflow(tabId, job);

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
