import { claimJob, handshake, reportJobDone, reportJobFailed, type ToolJob } from "./api";
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

async function executeInTab(tabId: number, job: ToolJob) {
  return chrome.tabs.sendMessage(tabId, { action: "zohoAgentExecuteJob", job }) as Promise<{
    ok?: boolean;
    result?: unknown;
    error_message?: string;
    error_code?: string;
  }>;
}

async function pollOnce() {
  if (inFlight) return;
  const settings = await loadSettings();
  if (!settings.enabled) return;

  const tab = await crmTab();
  if (!tab?.id) return;

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
    await saveLastJobStatus(`Running ${claimed.job.tool_name} (${claimed.job.id}).`);

    let response: Awaited<ReturnType<typeof executeInTab>>;
    try {
      response = await executeInTab(tab.id, claimed.job);
    } catch (error) {
      response = {
        ok: false,
        error_message: error instanceof Error ? error.message : "Could not reach the Zoho content script."
      };
    }

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
