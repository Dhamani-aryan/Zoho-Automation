import { errorCode, executeZohoTool } from "./zoho-api";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const object = message && typeof message === "object" ? (message as Record<string, unknown>) : null;
  const action = object?.action;
  if (action === "zohoAgentPing") {
    sendResponse({
      ok: true,
      href: window.location.href,
      hasToken: Boolean(document.getElementById("token"))
    });
    return true;
  }
  if (action === "zohoAgentExecuteJob") {
    const job = object?.job as { tool_name?: string; args?: Record<string, unknown> } | undefined;
    if (!job?.tool_name || !job.args) {
      sendResponse({ ok: false, error_message: "Invalid extension job payload." });
      return true;
    }
    executeZohoTool({ tool_name: job.tool_name, args: job.args })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error_message: error instanceof Error ? error.message : "Zoho tool failed.",
          error_code: errorCode(error)
        })
      );
    return true;
  }
  return false;
});
