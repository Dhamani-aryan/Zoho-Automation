import { claimJob, handshake, reportJobDone, reportJobFailed, type ToolJob } from "./api";
import { zohoPageRunner, type PageResult } from "./page-runner";
import { loadSettings, saveLastJobStatus } from "./storage";

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

// Runs the read-only executor in the page's MAIN world via chrome.scripting.
// Inline <script> injection is blocked by Zoho's CSP; executeScript is not.
async function executeInTab(tabId: number, job: ToolJob): Promise<PageResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: zohoPageRunner,
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
    const status = await handshake(settings);
    await saveLastJobStatus(`Connected. ${status.queued_jobs ?? 0} queued agent job(s).`);

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
        response.error_code
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
