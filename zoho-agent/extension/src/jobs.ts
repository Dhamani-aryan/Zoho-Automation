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

let inFlight = false;
let idleSince = Date.now();
let timer: number | undefined;

function crmTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "https://crm.zoho.com/*" }, resolve);
  });
}

async function crmTab() {
  const tabs = await crmTabs();
  return tabs.find((tab) => typeof tab.id === "number") ?? null;
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

async function runBackgroundUiStep(tabId: number, job: ToolJob): Promise<PageResult | null> {
  if (job.tool_name !== "ui_step") return null;
  const step = (job.args.step ?? {}) as Record<string, unknown>;
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
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    if (dataUrl.length > 500 * 1024) {
      return { ok: false, error_message: "Screenshot exceeded the 500 KB cap." };
    }
    return { ok: true, result: { screenshot_data_url: dataUrl } };
  }

  return null;
}

// Runs the read-only executor in the page's MAIN world via chrome.scripting.
// Inline <script> injection is blocked by Zoho's CSP; executeScript is not.
async function executeInTab(tabId: number, job: ToolJob): Promise<PageResult> {
  const isWrite = WRITE_TOOLS.has(job.tool_name);
  const backgroundUiResult = await runBackgroundUiStep(tabId, job);
  if (backgroundUiResult) return backgroundUiResult;

  // Belt-and-braces (3 of 3): a write job must carry an approval_id. Even if the
  // server checks were somehow bypassed, the extension refuses to write without
  // one.
  if (isWrite && !job.approval_id) {
    return { ok: false, error_message: "write without approval refused by extension" };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: job.tool_name === "ui_step" ? zohoUiPageRunner : isWrite ? zohoWritePageRunner : zohoPageRunner,
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
    const tab = await crmTab();
    if (!tab?.id) {
      const message =
        "No crm.zoho.com tab is open in this Chrome profile. Open Zoho CRM in a tab and ask again.";
      await reportJobFailed(settings, claimed.job.id, message);
      await saveLastJobStatus(`Failed ${claimed.job.tool_name}: no crm.zoho.com tab open.`);
      return;
    }

    await saveLastJobStatus(`Running ${claimed.job.tool_name} in tab ${tab.id}.`);
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
