type PageJob = {
  tool_name: string;
  args: Record<string, unknown>;
};

type PageResult =
  | { ok: true; result: unknown }
  | { ok: false; error_message: string; error_code?: string };

const PAGE_EXECUTION_TIMEOUT_MS = 20000;

function pageRunner(payload: { requestId: string; job: PageJob }) {
  const ZOHO_BASE = "https://crm.zoho.com";
  const ORG_ID = "890324941";
  const REQUEST_TIMEOUT_MS = 15000;

  class ZohoLoggedOutError extends Error {
    errorCode = "zoho_logged_out";
  }

  function post(result: PageResult) {
    window.postMessage({ source: "zoho-agent-page", requestId: payload.requestId, ...result }, window.location.origin);
  }

  function token() {
    const value = (document.getElementById("token") as HTMLInputElement | null)?.value;
    if (!value) throw new ZohoLoggedOutError("Zoho login token was not found. Refresh or sign back into crm.zoho.com.");
    return value;
  }

  function headers() {
    return {
      "X-ZCSRF-TOKEN": `crmcsrfparam=${token()}`,
      "X-CRM-ORG": ORG_ID,
      "X-Requested-With": "XMLHttpRequest"
    };
  }

  function cleanPrefix(value: string) {
    return value.replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  }

  function nameField(moduleName: string) {
    if (moduleName === "Accounts") return "Account_Name";
    if (moduleName === "Contacts") return "Full_Name";
    return "Deal_Name";
  }

  async function getJson(path: string, params: Record<string, string> = {}) {
    const url = new URL(path, ZOHO_BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: headers(),
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 204) return { data: [], info: { more_records: false } };
      if (response.status === 401 || response.status === 403 || response.redirected || !contentType.includes("json")) {
        throw new ZohoLoggedOutError("Zoho returned a login/auth response instead of JSON. Sign back into crm.zoho.com.");
      }

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const code = typeof body.code === "string" ? body.code : "";
      if (code === "INVALID_TICKET" || code === "AUTHENTICATION_FAILURE") {
        throw new ZohoLoggedOutError(`Zoho authentication failed: ${code}.`);
      }
      if (!response.ok) {
        const message = [code, typeof body.message === "string" ? body.message : ""].filter(Boolean).join(": ");
        throw new Error(message || `Zoho GET failed with ${response.status}.`);
      }
      return body;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Zoho GET timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function searchRecords(args: Record<string, unknown>) {
    const moduleName = String(args.module ?? "");
    const page = String(args.page ?? 1);
    let criteria = typeof args.criteria === "string" ? args.criteria : "";
    if (typeof args.name === "string") criteria = `(${nameField(moduleName)}:equals:${args.name})`;
    if (typeof args.tag === "string") criteria = `(Tag:equals:${args.tag})`;

    try {
      return await getJson(`/crm/v3/${moduleName}/search`, { criteria, page, per_page: "200" });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("INVALID_QUERY") || typeof args.name !== "string") {
        throw error;
      }
      const prefix = cleanPrefix(args.name);
      if (!prefix) throw error;
      return getJson(`/crm/v3/${moduleName}/search`, {
        criteria: `(${nameField(moduleName)}:starts_with:${prefix})`,
        page,
        per_page: "200"
      });
    }
  }

  function getRecord(args: Record<string, unknown>) {
    const moduleName = String(args.module ?? "");
    const fields = Array.isArray(args.fields) ? args.fields.join(",") : "";
    return getJson(`/crm/v3/${moduleName}/${String(args.zoho_id)}`, { fields });
  }

  function getRelated(args: Record<string, unknown>) {
    return getJson(`/crm/v3/Accounts/${String(args.account_zoho_id)}/${String(args.child)}`, {
      page: String(args.page ?? 1),
      per_page: "200"
    });
  }

  function rawGet(args: Record<string, unknown>) {
    const params =
      args.params && typeof args.params === "object" && !Array.isArray(args.params)
        ? (args.params as Record<string, string>)
        : {};
    return getJson(String(args.path), params);
  }

  async function execute() {
    const { job } = payload;
    if (job.tool_name === "zoho_search") return searchRecords(job.args);
    if (job.tool_name === "zoho_get_record") return getRecord(job.args);
    if (job.tool_name === "zoho_get_related") return getRelated(job.args);
    if (job.tool_name === "zoho_read_api") return rawGet(job.args);
    throw new Error("tool not supported by this extension version");
  }

  execute()
    .then((result) => post({ ok: true, result }))
    .catch((error) =>
      post({
        ok: false,
        error_message: error instanceof Error ? error.message : "Zoho tool failed.",
        error_code: error instanceof ZohoLoggedOutError ? error.errorCode : undefined
      })
    );
}

function executeZohoToolInPage(job: PageJob): Promise<PageResult> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error_message: "Timed out waiting for the Zoho page-context executor." });
    }, PAGE_EXECUTION_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as Record<string, unknown> | null;
      if (data?.source !== "zoho-agent-page" || data.requestId !== requestId) return;

      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (data.ok === true) {
        resolve({ ok: true, result: data.result });
      } else {
        resolve({
          ok: false,
          error_message: typeof data.error_message === "string" ? data.error_message : "Zoho tool failed.",
          error_code: typeof data.error_code === "string" ? data.error_code : undefined
        });
      }
    }

    window.addEventListener("message", onMessage);
    const script = document.createElement("script");
    script.textContent = `(${pageRunner.toString()})(${JSON.stringify({ requestId, job })});`;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  });
}

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
    executeZohoToolInPage({ tool_name: job.tool_name, args: job.args }).then(sendResponse);
    return true;
  }
  return false;
});
