chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message && typeof message === "object" ? (message as { action?: unknown }).action : null;
  if (action === "zohoAgentPing") {
    sendResponse({
      ok: true,
      href: window.location.href,
      hasToken: Boolean(document.getElementById("token"))
    });
    return true;
  }
  return false;
});
