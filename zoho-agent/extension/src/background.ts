import { claim, handshake, reportSkipped } from "./api";
import { pollAgentJobOnce, startJobPolling, startJobStream } from "./jobs";
import { loadSettings } from "./storage";

const ALARM_NAME = "zoho-agent-poll";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

startJobStream();
startJobPolling();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void dryPollOnce().catch(() => undefined);
    // MV3 kills the service worker (and its setTimeout poll chain) after
    // ~30s idle. The alarm both wakes the worker (module re-runs
    // startJobPolling) and kicks one immediate job poll so pickup latency
    // is bounded by the alarm period instead of stalling forever.
    void pollAgentJobOnce().catch(() => undefined);
  }
});

async function dryPollOnce() {
  const settings = await loadSettings();
  if (!settings.enabled) return { ok: true, skipped: "disabled" };

  const connected = await handshake(settings);
  const run = connected.approved_runs[0];
  if (!run) return { ok: true, skipped: "no_runs" };

  const claimed = await claim(settings, run.id);
  if (!claimed.item) return { ok: true, skipped: claimed.run_complete ? "run_complete" : "no_item" };

  await reportSkipped(settings, claimed.item.id);
  return { ok: true, item_id: claimed.item.id };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message && typeof message === "object" ? (message as { action?: unknown }).action : null;
  if (action === "pollAgentJobOnce") {
    pollAgentJobOnce()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Job poll failed." }));
    return true;
  }
  if (action !== "dryPollOnce") return false;

  dryPollOnce()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Dry poll failed." }));
  return true;
});
