export type PageJob = {
  tool_name: string;
  args: Record<string, unknown>;
};

export type PageResult =
  | { ok: true; result: unknown }
  | { ok: false; error_message: string; error_code?: string };

// Executed via chrome.scripting.executeScript({ world: "MAIN" }) — runs in the
// real crm.zoho.com page context, immune to the page's CSP for inline
// <script> tags (which Zoho blocks). MUST stay fully self-contained: no
// imports, no closures over module scope (it is serialized with toString()).
// GET-only by design — Phase B is read-only.
export async function zohoPageRunner(job: {
  tool_name: string;
  args: Record<string, unknown>;
}): Promise<
  { ok: true; result: unknown } | { ok: false; error_message: string; error_code?: string }
> {
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
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: {
          "X-ZCSRF-TOKEN": `crmcsrfparam=${token()}`,
          "X-CRM-ORG": ORG_ID,
          "X-Requested-With": "XMLHttpRequest"
        },
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 204) return { data: [], info: { more_records: false } };
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
        throw new Error(message || `Zoho GET failed with ${response.status}.`);
      }
      return body;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Zoho GET timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
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

  try {
    let result: unknown;
    if (job.tool_name === "zoho_search") result = await searchRecords(job.args);
    else if (job.tool_name === "zoho_get_record") result = await getRecord(job.args);
    else if (job.tool_name === "zoho_get_related") result = await getRelated(job.args);
    else if (job.tool_name === "zoho_read_api") result = await rawGet(job.args);
    else return { ok: false, error_message: "tool not supported by this extension version" };
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error_message: error instanceof Error ? error.message : "Zoho tool failed.",
      error_code:
        error instanceof Error && (error as Error & { errorCode?: string }).errorCode === LOGGED_OUT
          ? LOGGED_OUT
          : undefined
    };
  }
}
