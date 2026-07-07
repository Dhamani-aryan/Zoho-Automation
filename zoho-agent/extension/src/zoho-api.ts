const ZOHO_BASE = "https://crm.zoho.com";
const ORG_ID = "890324941";
const REQUEST_TIMEOUT_MS = 15000;

type ModuleName = "Accounts" | "Contacts" | "Deals";

type ZohoToolJob = {
  tool_name: string;
  args: Record<string, unknown>;
};

class ZohoLoggedOutError extends Error {
  errorCode = "zoho_logged_out";
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

function nameField(module: ModuleName) {
  if (module === "Accounts") return "Account_Name";
  if (module === "Contacts") return "Full_Name";
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

    if (response.status === 204) return { data: [], info: { more_records: false } };
    if (response.status === 401 || response.redirected) {
      throw new ZohoLoggedOutError("Zoho returned an authentication error. Sign back into crm.zoho.com.");
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const details = body as { code?: string; message?: string };
      const message = [details.code, details.message].filter(Boolean).join(": ");
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
  const moduleName = args.module as ModuleName;
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
  const moduleName = args.module as ModuleName;
  const fields = Array.isArray(args.fields) ? args.fields.join(",") : "";
  return getJson(`/crm/v3/${moduleName}/${String(args.zoho_id)}`, { fields });
}

function getRelated(args: Record<string, unknown>) {
  const child = args.child as "Contacts" | "Deals";
  return getJson(`/crm/v3/Accounts/${String(args.account_zoho_id)}/${child}`, {
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

export async function executeZohoTool(job: ZohoToolJob) {
  if (job.tool_name === "zoho_search") return searchRecords(job.args);
  if (job.tool_name === "zoho_get_record") return getRecord(job.args);
  if (job.tool_name === "zoho_get_related") return getRelated(job.args);
  if (job.tool_name === "zoho_read_api") return rawGet(job.args);
  throw new Error("tool not supported by this extension version");
}

export function errorCode(error: unknown) {
  return error instanceof ZohoLoggedOutError ? error.errorCode : undefined;
}
