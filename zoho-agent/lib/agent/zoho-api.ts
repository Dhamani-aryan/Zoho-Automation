import { z } from "zod";

const apiModules = ["Accounts", "Contacts", "Deals", "Tasks"] as const;
const apiMethods = ["GET", "POST", "PUT"] as const;
const maxParams = 12;

export type ZohoApiMethod = (typeof apiMethods)[number];
export type ZohoApiModule = (typeof apiModules)[number];

const methodSchema = z.preprocess((value) => String(value ?? "").trim().toUpperCase(), z.enum(apiMethods));

const paramsSchema = z
  .record(z.string().trim().min(1), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .default({})
  .transform((params) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) out[key] = String(value);
    return out;
  });

export function moduleFromZohoApiPath(path: string): string | null {
  const match = path.match(/^\/crm\/v(?:3|2\.2)\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function isBlockedZohoApiPath(path: string): boolean {
  return [
    /\/actions\/(?:delete|mass_delete)\b/i,
    /\/delete\b/i,
    /\/actions\/[^/?#]*send/i,
    /\/send(?:mail|_mail|now|_now)?\b/i
  ].some((pattern) => pattern.test(path));
}

export function isAllowedZohoApiPath(path: string, method: ZohoApiMethod = "GET"): boolean {
  if (isBlockedZohoApiPath(path)) return false;
  if (/^\/crm\/v3\/settings\/fields$/.test(path)) return true;
  if (/^\/crm\/v3\/users$/.test(path)) return true;

  const moduleName = moduleFromZohoApiPath(path);
  if (!moduleName || !(apiModules as readonly string[]).includes(moduleName)) return false;

  const readPatterns = [
    /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)$/,
    /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+$/,
    /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)\/search$/,
    /^\/crm\/v3\/Accounts\/[A-Za-z0-9]+\/(Contacts|Deals)$/,
    /^\/crm\/v2\.2\/(Accounts|Contacts|Deals|Tasks)$/,
    /^\/crm\/v2\.2\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+$/
  ];
  const writePatterns = [
    /^\/crm\/v(?:3|2\.2)\/(Accounts|Contacts|Deals|Tasks)$/,
    /^\/crm\/v(?:3|2\.2)\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+$/,
    /^\/crm\/v(?:3|2\.2)\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+\/actions\/(?:add_tags|remove_tags)$/
  ];
  return (method === "GET" ? readPatterns : writePatterns).some((pattern) => pattern.test(path));
}

export const zohoApiReadSchema = z
  .object({
    method: methodSchema,
    path: z.string().trim().startsWith("/"),
    params: paramsSchema,
    body: z.unknown().optional()
  })
  .strict()
  .superRefine((args, ctx) => {
    if (!isAllowedZohoApiPath(args.path, args.method)) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "zoho_api path is not in the Zoho CRM allowlist." });
    }
    if (args.method === "GET" && args.body !== undefined) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "zoho_api GET must not include a body." });
    }
    if (args.method !== "GET" && args.body === undefined) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "zoho_api POST/PUT requires a JSON body." });
    }
  })
  .refine((args) => Object.keys(args.params).length <= maxParams, {
    message: `zoho_api params are limited to ${maxParams} keys.`
  });

export type ZohoApiReadArgs = z.infer<typeof zohoApiReadSchema>;

export type ZohoApiArgs = ZohoApiReadArgs;

export function isZohoApiWriteArgs(args: unknown): boolean {
  const method = args && typeof args === "object" ? (args as { method?: unknown }).method : null;
  return String(method ?? "").trim().toUpperCase() === "POST" || String(method ?? "").trim().toUpperCase() === "PUT";
}

export function zohoApiRecordUsage(args: unknown): number {
  if (!isZohoApiWriteArgs(args)) return 0;
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {};
  const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
  if (data.length > 0) {
    const ids = new Set(data.map((row) => (typeof row?.id === "string" ? row.id.trim() : "")).filter(Boolean));
    return ids.size || data.length;
  }
  const path = typeof input.path === "string" ? input.path : "";
  return /^\/crm\/v(?:3|2\.2)\/(?:Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+(?:$|\/actions\/)/.test(path) ? 1 : 0;
}

function responseRows(result: unknown): Array<Record<string, unknown>> {
  const body = result && typeof result === "object" ? (result as { body?: unknown }).body : null;
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

function responseRowId(row: Record<string, unknown>) {
  const details = row.details;
  if (details && typeof details === "object" && typeof (details as { id?: unknown }).id === "string") {
    return (details as { id: string }).id;
  }
  return typeof row.id === "string" ? row.id : null;
}

export function zohoApiWriteTargets(args: unknown, result?: unknown) {
  if (!isZohoApiWriteArgs(args)) return [];
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const moduleName = moduleFromZohoApiPath(typeof input.path === "string" ? input.path : "");
  if (!moduleName || !(apiModules as readonly string[]).includes(moduleName)) return [];
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {};
  const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
  const rows = responseRows(result);
  return data
    .map((row, index) => {
      const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : responseRowId(rows[index] ?? {});
      if (!id) return null;
      const fields = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id"));
      return { module: moduleName as ZohoApiModule, id, fields };
    })
    .filter((value): value is { module: ZohoApiModule; id: string; fields: Record<string, unknown> } => Boolean(value));
}

function normalizeComparable(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const maybeLookup = value as { id?: unknown; name?: unknown };
    if (typeof maybeLookup.id === "string") return maybeLookup.id.trim();
    if (typeof maybeLookup.name === "string") return maybeLookup.name.trim();
    return JSON.stringify(value);
  }
  return String(value).trim();
}

export function compareZohoApiReadBack(expected: Record<string, unknown>, actual: Record<string, unknown>) {
  const verifiedFields: Record<string, unknown> = {};
  const mismatches: string[] = [];
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[field] ?? null;
    if (normalizeComparable(actualValue) === normalizeComparable(expectedValue)) {
      verifiedFields[field] = actualValue;
    } else {
      mismatches.push(field);
    }
  }
  return { verified: mismatches.length === 0, verified_fields: verifiedFields, mismatches };
}

export function shapeZohoApiResponse(status: number, body: unknown) {
  if (status === 204) return { status: 204, empty: true };
  return { status, body };
}
