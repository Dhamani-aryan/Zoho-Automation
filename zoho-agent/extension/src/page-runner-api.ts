export type ApiPageResult =
  | { ok: true; result: unknown }
  | { ok: false; error_message: string; error_code?: string; result?: unknown };

// Executed via chrome.scripting.executeScript({ world: "MAIN" }) in the real
// crm.zoho.com page context. Keep this self-contained: executeScript serializes
// the function body, so it must not close over module scope.
export async function zohoApiPageRunner(job: {
  tool_name: string;
  args: Record<string, unknown>;
}): Promise<ApiPageResult> {
  const ZOHO_BASE = "https://crm.zoho.com";
  const ORG_ID = "890324941";
  const REQUEST_TIMEOUT_MS = 15000;
  const LOGGED_OUT = "zoho_logged_out";

  function token() {
    const value = (document.getElementById("token") as HTMLInputElement | null)?.value;
    if (!value) {
      const error = new Error("Zoho login token was not found. Refresh or sign back into crm.zoho.com.");
      (error as Error & { errorCode?: string }).errorCode = LOGGED_OUT;
      throw error;
    }
    return value;
  }

  function loggedOut(message: string) {
    const error = new Error(message);
    (error as Error & { errorCode?: string }).errorCode = LOGGED_OUT;
    return error;
  }

  function allowedPath(path: string) {
    if (/^\/crm\/v3\/settings\/fields$/.test(path)) return true;
    if (/^\/crm\/v3\/users$/.test(path)) return true;
    return [
      /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)$/,
      /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+$/,
      /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)\/search$/,
      /^\/crm\/v3\/Accounts\/[A-Za-z0-9]+\/(Contacts|Deals)$/,
      /^\/crm\/v2\.2\/(Accounts|Contacts|Deals|Tasks)$/,
      /^\/crm\/v2\.2\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+$/
    ].some((pattern) => pattern.test(path));
  }

  async function request(method: string, path: string, params: Record<string, string>) {
    const url = new URL(path, ZOHO_BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method,
        credentials: "include",
        headers: {
          "X-ZCSRF-TOKEN": `crmcsrfparam=${token()}`,
          "X-CRM-ORG": ORG_ID,
          "X-Requested-With": "XMLHttpRequest"
        },
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 204) return { status: 204, empty: true };
      if (response.status === 401 || response.status === 403 || response.redirected || !contentType.includes("json")) {
        throw loggedOut("Zoho returned a login/auth response instead of JSON. Sign back into crm.zoho.com.");
      }

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const code = typeof body.code === "string" ? body.code : "";
      if (code === "INVALID_TICKET" || code === "AUTHENTICATION_FAILURE") {
        throw loggedOut(`Zoho authentication failed: ${code}.`);
      }
      if (!response.ok) {
        const message = [code, typeof body.message === "string" ? body.message : ""].filter(Boolean).join(": ");
        throw new Error(message || `Zoho ${method} failed with ${response.status}.`);
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Zoho ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    if (job.tool_name !== "zoho_api") {
      return { ok: false, error_message: "tool not supported by this extension version" };
    }
    const method = String(job.args.method ?? "").trim().toUpperCase();
    const path = String(job.args.path ?? "").trim();
    const params =
      job.args.params && typeof job.args.params === "object" && !Array.isArray(job.args.params)
        ? Object.fromEntries(Object.entries(job.args.params as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        : {};

    if (method !== "GET") throw new Error("zoho_api H1 supports GET only.");
    if (!allowedPath(path)) throw new Error("zoho_api path is not in the extension CRM allowlist.");
    if (Object.keys(params).length > 12) throw new Error("zoho_api params are limited to 12 keys.");

    return { ok: true, result: await request(method, path, params) };
  } catch (error) {
    return {
      ok: false,
      error_message: error instanceof Error ? error.message : "Zoho API tool failed.",
      error_code:
        error instanceof Error && (error as Error & { errorCode?: string }).errorCode === LOGGED_OUT
          ? LOGGED_OUT
          : undefined
    };
  }
}
