// Job execution moved to chrome.scripting.executeScript({ world: "MAIN" })
// driven from the background worker (see jobs.ts + page-runner.ts). Zoho's
// page CSP blocks inline <script> injection, so the old content-script
// injection path could never run. The content script now only answers pings.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const object = message && typeof message === "object" ? (message as Record<string, unknown>) : null;
  if (object?.action === "zohoAgentPing") {
    sendResponse({
      ok: true,
      href: window.location.href,
      hasToken: Boolean(document.getElementById("token"))
    });
    return true;
  }
  return false;
});
