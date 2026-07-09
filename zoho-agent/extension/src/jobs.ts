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

async function createAgentWindow(url: string) {
  const created = await chrome.windows.create({ url, focused: true, type: "normal" });
  const tab = created.tabs?.find((item) => typeof item.id === "number") ?? null;
  const tabId = tab?.id ?? null;
  await saveAgentTarget(created.id ?? null, tabId);
  if (tabId) await waitForTabComplete(tabId);
  return tabId ? await chrome.tabs.get(tabId) : null;
}

async function crmTabForJob(job: ToolJob) {
  const stored = await usableStoredTab();
  if (stored?.id) {
    if (typeof stored.windowId === "number") {
      await chrome.windows.update(stored.windowId, { focused: true, state: "normal" }).catch(() => undefined);
    }
    await chrome.tabs.update(stored.id, { active: true });
    return stored;
  }

  const created = await createAgentWindow(initialUrlForJob(job));
  if (created?.id) return created;

  const tabs = await crmTabs();
  const existing = tabs.find((tab) => typeof tab.id === "number") ?? null;
  if (existing?.id) {
    await saveAgentTarget(existing.windowId ?? null, existing.id);
    if (typeof existing.windowId === "number") {
      await chrome.windows.update(existing.windowId, { focused: true, state: "normal" }).catch(() => undefined);
    }
    await chrome.tabs.update(existing.id, { active: true });
  }
  return existing;
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
      error_message: `Could not run UI step in the Zoho tab${
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
  if ((job.args.effect === "write" || hasMutatingStep) && !job.approval_id) {
    return { ok: false, error_message: "write workflow without approval refused by extension" };
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

  // Belt-and-braces (3 of 3): a write job must carry an approval_id. Even if the
  // server checks were somehow bypassed, the extension refuses to write without
  // one.
  if (isWrite && !job.approval_id) {
    return { ok: false, error_message: "write without approval refused by extension" };
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
