import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const modules = ["Accounts", "Contacts", "Deals"] as const;
const relatedChildren = ["Contacts", "Deals"] as const;

const moduleSchema = z.preprocess(
  (value) => {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "accounts") return "Accounts";
    if (raw === "contacts") return "Contacts";
    if (raw === "deals") return "Deals";
    return value;
  },
  z.enum(modules)
);

const pageSchema = z.preprocess((value) => (value == null ? 1 : Number(value)), z.number().int().min(1).max(50));

const zohoSearchSchema = z
  .object({
    module: moduleSchema,
    criteria: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    tag: z.string().trim().min(1).optional(),
    page: pageSchema.default(1)
  })
  .refine((args) => [args.criteria, args.name, args.tag].filter(Boolean).length === 1, {
    message: "zoho_search requires exactly one of criteria, name, or tag."
  });

const zohoGetRecordSchema = z.object({
  module: moduleSchema,
  zoho_id: z.string().trim().min(1),
  fields: z.array(z.string().trim().min(1)).min(1).max(30)
});

const zohoGetRelatedSchema = z.object({
  account_zoho_id: z.string().trim().min(1),
  child: z.enum(relatedChildren),
  page: pageSchema.default(1)
});

const allowedReadApiPaths = [
  /^\/crm\/v3\/(Accounts|Contacts|Deals)(\/[A-Za-z0-9]+)?(\/(Contacts|Deals))?$/,
  /^\/crm\/v3\/(Accounts|Contacts|Deals)\/search$/,
  /^\/crm\/v3\/settings\/fields$/,
  /^\/crm\/v3\/users$/
];

const zohoReadApiSchema = z.object({
  path: z.string().trim().refine((path) => allowedReadApiPaths.some((pattern) => pattern.test(path)), {
    message: "zoho_read_api path is not in the GET allowlist."
  }),
  params: z.record(z.string(), z.string()).optional().default({})
}).refine((args) => Object.keys(args.params).length <= 8, {
  message: "zoho_read_api params are limited to 8 keys."
});

export const TIER1_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "zoho_search",
    tier: 1,
    description:
      "Read-only live Zoho search through the user's Chrome session. Use for current single-record lookups when the extension is connected.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module"],
      properties: {
        module: { type: "string", enum: modules },
        criteria: { type: "string" },
        name: { type: "string" },
        tag: { type: "string" },
        page: { type: "integer", minimum: 1, maximum: 50, default: 1 }
      }
    }
  },
  {
    name: "zoho_get_record",
    tier: 1,
    description: "Read selected fields for one live Zoho Accounts, Contacts, or Deals record by Zoho id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "zoho_id", "fields"],
      properties: {
        module: { type: "string", enum: modules },
        zoho_id: { type: "string" },
        fields: { type: "array", minItems: 1, maxItems: 30, items: { type: "string" } }
      }
    }
  },
  {
    name: "zoho_get_related",
    tier: 1,
    description: "Read live Contacts or Deals related to one Account by Account Zoho id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["account_zoho_id", "child"],
      properties: {
        account_zoho_id: { type: "string" },
        child: { type: "string", enum: relatedChildren },
        page: { type: "integer", minimum: 1, maximum: 50, default: 1 }
      }
    }
  },
  {
    name: "zoho_read_api",
    tier: 1,
    description: "GET-only escape hatch for allowlisted Zoho CRM v3 read paths. Never use for writes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        params: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 8
        }
      }
    }
  }
];

export type Tier1ToolName = (typeof TIER1_TOOL_DEFINITIONS)[number]["name"];

export function isTier1Tool(name: string): name is Tier1ToolName {
  return TIER1_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

async function assertFieldsExist(service: SupabaseClient, module: string, fields: string[]) {
  const uniqueFields = [...new Set(fields)];
  const { data, error } = await service
    .from("zoho_field_meta")
    .select("api_name")
    .eq("module", module)
    .in("api_name", uniqueFields);

  if (error) throw error;
  const found = new Set((data ?? []).map((row) => row.api_name as string));
  const missing = uniqueFields.filter((field) => !found.has(field));
  if (missing.length > 0) {
    throw new Error(`Unknown ${module} field(s): ${missing.join(", ")}.`);
  }
}

export async function validateTier1ToolCall(call: AgentToolCall, service: SupabaseClient): Promise<AgentToolCall> {
  if (call.name === "zoho_search") {
    const args = zohoSearchSchema.parse(call.args);
    return { ...call, args };
  }

  if (call.name === "zoho_get_record") {
    const args = zohoGetRecordSchema.parse(call.args);
    await assertFieldsExist(service, args.module, args.fields);
    return { ...call, args };
  }

  if (call.name === "zoho_get_related") {
    const args = zohoGetRelatedSchema.parse(call.args);
    return { ...call, args };
  }

  if (call.name === "zoho_read_api") {
    const args = zohoReadApiSchema.parse(call.args);
    return { ...call, args };
  }

  throw new Error(`Unknown Tier-1 tool: ${call.name}`);
}
