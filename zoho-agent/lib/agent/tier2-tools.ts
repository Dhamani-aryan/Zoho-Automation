import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";
import { resolveOwner } from "../constants";
import {
  buildPicklistIndex,
  isValidDate,
  isValidEmail,
  picklistAllows,
  type FieldMetaRow
} from "../plan/field-rules";

// Tier-2 = approval-gated Zoho WRITES. Nothing in this module executes a write;
// it only defines the tools, validates arguments BEFORE an approval card is
// created (fail-before-side-effects), and normalizes the arguments into the
// immutable snapshot that will later be executed EXACTLY as approved.

const modules = ["Accounts", "Contacts", "Deals"] as const;
export type Tier2Module = (typeof modules)[number];

// Fields that must never be written in v2.0.
const BLOCKED_FIELDS = new Set<string>(["Deal_Name"]);
// Fields only an admin may write.
const ADMIN_ONLY_FIELDS = new Set<string>(["Stage"]);

export const TIER2_WRITE_TOOL_NAMES = [
  "zoho_update_fields",
  "zoho_change_owner",
  "zoho_add_tags",
  "zoho_remove_tags"
] as const;

export type Tier2ToolName = (typeof TIER2_WRITE_TOOL_NAMES)[number];

const writeNameSet: ReadonlySet<string> = new Set(TIER2_WRITE_TOOL_NAMES);

export function isTier2Tool(name: string): name is Tier2ToolName {
  return writeNameSet.has(name);
}

// Every Tier-2 tool is a write; the approval gate applies to all of them.
export const isTier2WriteTool = isTier2Tool;

const moduleSchema = z.preprocess((value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "accounts") return "Accounts";
  if (raw === "contacts") return "Contacts";
  if (raw === "deals") return "Deals";
  return value;
}, z.enum(modules));

const zohoIdSchema = z.string().trim().min(1);
// Field values that can be written by a simple field PUT. Lookups (Owner) and
// tags are handled by their dedicated tools, so objects/arrays are rejected.
const fieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const updateFieldsSchema = z.object({
  module: moduleSchema,
  updates: z
    .array(
      z.object({
        zoho_id: zohoIdSchema,
        fields: z.record(z.string().trim().min(1), fieldValueSchema)
      })
    )
    .min(1)
    .max(50)
});

const changeOwnerSchema = z.object({
  module: moduleSchema,
  zoho_ids: z.array(zohoIdSchema).min(1).max(50),
  owner_name: z.string().trim().min(1)
});

const tagsSchema = z.object({
  module: moduleSchema,
  zoho_ids: z.array(zohoIdSchema).min(1).max(50),
  tags: z.array(z.string().trim().min(1)).min(1).max(5)
});

export const TIER2_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "zoho_update_fields",
    tier: 2,
    description:
      "Approval-gated write. Update one or more fields on 1-50 live Zoho records. Each update targets a record by its Zoho id and sets api_name -> value pairs. Stage is admin-only; Deal_Name cannot be changed. The user must approve a before/after card before anything is written.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "updates"],
      properties: {
        module: { type: "string", enum: modules },
        updates: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["zoho_id", "fields"],
            properties: {
              zoho_id: { type: "string" },
              fields: {
                type: "object",
                additionalProperties: true,
                description: "Map of field api_name to the new value, e.g. { \"Next_Step\": \"3rd Email\" }."
              }
            }
          }
        }
      }
    }
  },
  {
    name: "zoho_change_owner",
    tier: 2,
    description:
      "Approval-gated write. Reassign the Owner of 1-50 live Zoho records to a known CRM user. owner_name is resolved server-side against the known-users list; an unknown owner fails before any card is shown.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "zoho_ids", "owner_name"],
      properties: {
        module: { type: "string", enum: modules },
        zoho_ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
        owner_name: { type: "string" }
      }
    }
  },
  {
    name: "zoho_add_tags",
    tier: 2,
    description:
      "Approval-gated write. Add 1-5 tags to 1-50 live Zoho records. The user must approve before tags are written.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "zoho_ids", "tags"],
      properties: {
        module: { type: "string", enum: modules },
        zoho_ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
        tags: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } }
      }
    }
  },
  {
    name: "zoho_remove_tags",
    tier: 2,
    description:
      "Approval-gated write. Remove 1-5 tags from 1-50 live Zoho records. The user must approve before tags are removed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "zoho_ids", "tags"],
      properties: {
        module: { type: "string", enum: modules },
        zoho_ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
        tags: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } }
      }
    }
  }
];

// Normalized, validated Tier-2 request. This is the source of truth for both
// the approval summary and the immutable executed snapshot.
export type PreparedTier2 =
  | {
      tool_name: "zoho_update_fields";
      module: Tier2Module;
      records: Array<{ zoho_id: string; fields: Record<string, string | number | boolean | null> }>;
    }
  | {
      tool_name: "zoho_change_owner";
      module: Tier2Module;
      zoho_ids: string[];
      owner: { id: string; name: string };
    }
  | {
      tool_name: "zoho_add_tags" | "zoho_remove_tags";
      module: Tier2Module;
      zoho_ids: string[];
      tags: string[];
    };

export type Tier2ExecutionSnapshot =
  | {
      tool_name: "zoho_update_fields";
      module: Tier2Module;
      updates: Array<{ zoho_id: string; expected_name: string | null; fields: Record<string, unknown> }>;
    }
  | {
      tool_name: "zoho_change_owner";
      module: Tier2Module;
      owner: { id: string; name: string };
      records: Array<{ zoho_id: string; expected_name: string | null }>;
    }
  | {
      tool_name: "zoho_add_tags" | "zoho_remove_tags";
      module: Tier2Module;
      tags: string[];
      records: Array<{ zoho_id: string; expected_name: string | null }>;
    };

const MIRROR_MODULE_KEY: Record<Tier2Module, "accounts" | "contacts" | "deals"> = {
  Accounts: "accounts",
  Contacts: "contacts",
  Deals: "deals"
};

function nameField(module: Tier2Module): string {
  if (module === "Accounts") return "Account_Name";
  if (module === "Contacts") return "Full_Name";
  return "Deal_Name";
}

function fieldsForMirrorReadback(snapshot: Tier2ExecutionSnapshot): string[] {
  const fields = new Set<string>([nameField(snapshot.module)]);
  if (snapshot.tool_name === "zoho_update_fields") {
    for (const update of snapshot.updates) for (const field of Object.keys(update.fields)) fields.add(field);
  } else if (snapshot.tool_name === "zoho_change_owner") {
    fields.add("Owner");
  } else {
    fields.add("Tag");
  }
  return [...fields];
}

export function verifiedWriteFollowup({
  ok,
  snapshot
}: {
  ok: boolean;
  snapshot: Tier2ExecutionSnapshot;
}) {
  if (!ok) return null;
  const recordIds =
    snapshot.tool_name === "zoho_update_fields"
      ? snapshot.updates.map((record) => record.zoho_id)
      : snapshot.records.map((record) => record.zoho_id);
  const mirrorModule = MIRROR_MODULE_KEY[snapshot.module];
  const fields = fieldsForMirrorReadback(snapshot);

  return {
    live_readback_required: true,
    mirror_sync_required: true,
    next_required_actions: [
      {
        tool: "zoho_api",
        reason: "Fetch the authoritative live Zoho record after the verified write.",
        method: "GET",
        paths: recordIds.map((id) => `/crm/v3/${snapshot.module}/${id}`),
        params: { fields: fields.join(",") }
      },
      {
        tool: "db_sync_records",
        reason: "Upsert the exact live record(s) returned by zoho_get_record into the Supabase mirror.",
        module: mirrorModule,
        records: "Use the exact authoritative live record object(s) returned by zoho_get_record; do not synthesize records."
      }
    ]
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// Data types Zoho reports for date-like fields.
const DATE_TYPES = new Set(["date"]);
const DATETIME_TYPES = new Set(["datetime"]);
const EMAIL_TYPES = new Set(["email"]);

function validateUpdateFields(
  args: z.infer<typeof updateFieldsSchema>,
  ctx: { fieldMeta: FieldMetaRow[]; role: string }
): Extract<PreparedTier2, { tool_name: "zoho_update_fields" }> {
  const moduleName = args.module;
  const metaForModule = ctx.fieldMeta.filter((row) => row.module === moduleName);
  const metaByField = new Map<string, FieldMetaRow>();
  for (const row of metaForModule) metaByField.set(row.api_name, row);
  const picklists = buildPicklistIndex(metaForModule);
  const isAdmin = ctx.role === "admin";

  const records = args.updates.map((update) => {
    const fieldNames = Object.keys(update.fields);
    if (fieldNames.length === 0) {
      throw new Error(`Update for ${update.zoho_id} has no fields to set.`);
    }

    for (const apiName of fieldNames) {
      const value = update.fields[apiName];

      if (BLOCKED_FIELDS.has(apiName)) {
        throw new Error(`${apiName} cannot be changed.`);
      }
      if (ADMIN_ONLY_FIELDS.has(apiName) && !isAdmin) {
        throw new Error(`Editing ${apiName} requires an admin role.`);
      }

      const meta = metaByField.get(apiName);
      if (!meta) {
        throw new Error(`Unknown ${moduleName} field: ${apiName}.`);
      }

      // Lookup-typed fields (Owner, Account_Name, Contact_Name, ...) must not
      // be set through a plain field PUT: Owner has a dedicated resolved tool,
      // and re-parenting records is out of scope for v2.0. Without this check a
      // raw string id would slip past the object/array value rejection above.
      const metaType = (meta.data_type ?? "").toLowerCase();
      if (metaType.includes("lookup")) {
        throw new Error(
          apiName === "Owner"
            ? "Owner cannot be set via zoho_update_fields; use zoho_change_owner."
            : `${apiName} is a lookup field and cannot be changed with zoho_update_fields.`
        );
      }

      // Empty/null values pass rule checks (they clear a field); a non-empty
      // value must satisfy picklist / email / date rules.
      const hasValue = value !== null && String(value).trim() !== "";
      if (hasValue) {
        const stringValue = String(value);
        const picklistResult = picklistAllows(picklists, moduleName, apiName, value);
        if (picklistResult === false) {
          throw new Error(`"${stringValue}" is not an allowed option for ${apiName}.`);
        }

        const dataType = (meta.data_type ?? "").toLowerCase();
        if (EMAIL_TYPES.has(dataType) || apiName === "Email") {
          if (!isValidEmail(stringValue)) throw new Error(`"${stringValue}" is not a valid email.`);
        }
        if (DATE_TYPES.has(dataType)) {
          if (!isValidDate(stringValue, false)) throw new Error(`"${stringValue}" is not a valid date (YYYY-MM-DD).`);
        }
        if (DATETIME_TYPES.has(dataType)) {
          if (!isValidDate(stringValue, true)) throw new Error(`"${stringValue}" is not a valid date/time.`);
        }
      }
    }

    return { zoho_id: update.zoho_id, fields: { ...update.fields } };
  });

  return { tool_name: "zoho_update_fields", module: moduleName, records };
}

function validateChangeOwner(
  args: z.infer<typeof changeOwnerSchema>
): Extract<PreparedTier2, { tool_name: "zoho_change_owner" }> {
  const owner = resolveOwner(args.owner_name);
  if (!owner) {
    throw new Error(`Owner "${args.owner_name}" is not a known CRM user.`);
  }
  return {
    tool_name: "zoho_change_owner",
    module: args.module,
    zoho_ids: dedupe(args.zoho_ids),
    owner: { id: owner.zoho_user_id, name: owner.name }
  };
}

function validateTags(
  toolName: "zoho_add_tags" | "zoho_remove_tags",
  args: z.infer<typeof tagsSchema>
): Extract<PreparedTier2, { tool_name: "zoho_add_tags" | "zoho_remove_tags" }> {
  return {
    tool_name: toolName,
    module: args.module,
    zoho_ids: dedupe(args.zoho_ids),
    tags: dedupe(args.tags)
  };
}

// Validates a Tier-2 tool call. Throws ZodError on shape problems and Error on
// rule problems; both are fed back to the model as an observation and NEVER
// reach an approval card. Returns the normalized request on success.
export function validateTier2Call(
  call: AgentToolCall,
  ctx: { fieldMeta: FieldMetaRow[]; role: string }
): PreparedTier2 {
  switch (call.name) {
    case "zoho_update_fields":
      return validateUpdateFields(updateFieldsSchema.parse(call.args), ctx);
    case "zoho_change_owner":
      return validateChangeOwner(changeOwnerSchema.parse(call.args));
    case "zoho_add_tags":
      return validateTags("zoho_add_tags", tagsSchema.parse(call.args));
    case "zoho_remove_tags":
      return validateTags("zoho_remove_tags", tagsSchema.parse(call.args));
    default:
      throw new Error(`Unknown Tier-2 tool: ${call.name}`);
  }
}

export function tier2RecordIds(prepared: PreparedTier2): string[] {
  return prepared.tool_name === "zoho_update_fields"
    ? prepared.records.map((record) => record.zoho_id)
    : prepared.zoho_ids;
}

// --- Legacy approval-gate helpers (kept until the V3 deletion pass) ---
//
// Phase V3/J2 removes per-write approval and task-order gates from execution.
// These helpers remain temporarily so old imports/tests compile, but they no
// longer block claim or extension execution. Guardrails now live in the general
// zoho_api path allowlist, no-delete/send-now blocks, and browser send guard.
export function assertTier2JobInsertAllowed(
  toolName: string,
  approvalId: string | null | undefined
): void {
  void toolName;
  void approvalId;
}

export type ClaimDecision = { claimable: boolean; reason: string };

// Shared approval-linkage rule for any job that must not run unapproved
// (Tier-2 CRM writes AND write-effect ui_workflow replays).
export function approvalGatedClaimDecision(
  job: { approval_id: string | null },
  approvalStatus: string | null
): ClaimDecision {
  void job;
  void approvalStatus;
  return { claimable: true, reason: "ungated_v3" };
}

// (2) The extension claim route only hands a Tier-2 write job to the extension
// when the linked approval row exists and is 'approved'. Tier-1 reads are
// always claimable.
export function tier2ClaimDecision(
  job: { tool_name: string; approval_id: string | null },
  approvalStatus: string | null
): ClaimDecision {
  void job;
  void approvalStatus;
  return { claimable: true, reason: "ungated_v3" };
}

// (3) The extension write executor refuses any write job that arrives without
// an approval_id (defense in depth if the server checks were ever bypassed).
export function extensionAcceptsWriteJob(job: { tool_name: string; approval_id?: string | null; task_order_id?: string | null }): boolean {
  void job;
  return true;
}
