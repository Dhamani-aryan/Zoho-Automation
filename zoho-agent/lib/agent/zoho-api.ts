import { z } from "zod";

const apiModules = ["Accounts", "Contacts", "Deals", "Tasks"] as const;
const apiMethods = ["GET"] as const;
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

export function isAllowedZohoApiPath(path: string): boolean {
  if (/^\/crm\/v3\/settings\/fields$/.test(path)) return true;
  if (/^\/crm\/v3\/users$/.test(path)) return true;

  const moduleName = moduleFromZohoApiPath(path);
  if (!moduleName || !(apiModules as readonly string[]).includes(moduleName)) return false;

  return [
    /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)$/,
    /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+$/,
    /^\/crm\/v3\/(Accounts|Contacts|Deals|Tasks)\/search$/,
    /^\/crm\/v3\/Accounts\/[A-Za-z0-9]+\/(Contacts|Deals)$/,
    /^\/crm\/v2\.2\/(Accounts|Contacts|Deals|Tasks)$/,
    /^\/crm\/v2\.2\/(Accounts|Contacts|Deals|Tasks)\/[A-Za-z0-9]+$/
  ].some((pattern) => pattern.test(path));
}

export const zohoApiReadSchema = z
  .object({
    method: methodSchema,
    path: z.string().trim().startsWith("/").refine(isAllowedZohoApiPath, {
      message: "zoho_api path is not in the Zoho CRM allowlist."
    }),
    params: paramsSchema
  })
  .strict()
  .refine((args) => Object.keys(args.params).length <= maxParams, {
    message: `zoho_api params are limited to ${maxParams} keys.`
  });

export type ZohoApiReadArgs = z.infer<typeof zohoApiReadSchema>;

export function shapeZohoApiResponse(status: number, body: unknown) {
  if (status === 204) return { status: 204, empty: true };
  return { status, body };
}
