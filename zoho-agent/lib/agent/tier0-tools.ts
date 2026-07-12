import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";
import {
  crmFieldToColumn,
  fetchModuleRecords,
  MIRROR_MODULES,
  normalize,
  searchMirrorRecords,
  summarizeMirrorRecord,
  tagsOf,
  type MirrorModuleKey,
  type MirrorRecord
} from "@/lib/records/mirror";
import {
  readWorkspaceTextFile,
  workspaceRootFromCwd
} from "@/lib/agent/workspace-files";

const moduleSchema = z.preprocess(
  (value) => String(value ?? "").trim().toLowerCase(),
  z.enum(["accounts", "contacts", "deals"])
);

const limitedNumber = (fallback: number, max: number) =>
  z.preprocess((value) => (value == null ? fallback : Number(value)), z.number().int().min(1).max(max));

const dbSearchSchema = z.object({
  module: moduleSchema,
  query: z.string().min(1),
  limit: limitedNumber(8, 20).default(8)
});

const dbGetSchema = z.object({
  module: moduleSchema,
  id_or_zoho_id: z.string().min(1)
});

const dbTagSchema = z.object({
  module: moduleSchema,
  tag: z.string().min(1),
  limit: limitedNumber(25, 100).default(25)
});

const dbListTagsSchema = z.object({
  module: moduleSchema,
  limit: limitedNumber(50, 200).default(50)
});

const dbQuerySchema = z.object({
  module: moduleSchema,
  filters: z.array(
    z.object({
      field: z.string().min(1),
      op: z.enum(["equals", "contains", "starts_with"]),
      value: z.union([z.string(), z.number(), z.boolean()]).transform(String)
    })
  ).min(1).max(5),
  limit: limitedNumber(25, 100).default(25)
});

const requestNewToolSchema = z.object({
  name: z.string().min(2).max(80),
  purpose: z.string().min(5).max(1000),
  example_call: z.unknown().optional()
});

const readWorkspaceFileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  start_line: z.preprocess((value) => (value == null ? 1 : Number(value)), z.number().int().min(1)).default(1),
  max_lines: z.preprocess((value) => (value == null ? 100 : Number(value)), z.number().int().min(1).max(200)).default(100)
});

export const TIER0_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "read_workspace_file",
    tier: 0,
    description:
      "Read a paginated text file from the allowed local workspace roots: imports/samples, source_docs, workflows, reference/heysnap, or a local Codex attachment path under .codex/attachments. Use for drafts, batch inputs, and reference playbooks. Follow next_start_line until the required content is complete.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Workspace-relative or local Codex attachment .md, .txt, .csv, or .json path." },
        start_line: { type: "integer", minimum: 1, default: 1 },
        max_lines: { type: "integer", minimum: 1, maximum: 200, default: 100 }
      }
    }
  },
  {
    name: "db_search_records",
    tier: 0,
    description:
      "Search the local Supabase mirror for fast Account, Contact, or Deal discovery, ids, and URLs. Mirror data is as-of-last-sync; confirm live Zoho before writes or when current truth matters.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "query"],
      properties: {
        module: { type: "string", enum: ["accounts", "contacts", "deals"] },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 }
      }
    }
  },
  {
    name: "db_get_record",
    tier: 0,
    description: "Fetch one full record from the local mirror by internal id or Zoho id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "id_or_zoho_id"],
      properties: {
        module: { type: "string", enum: ["accounts", "contacts", "deals"] },
        id_or_zoho_id: { type: "string" }
      }
    }
  },
  {
    name: "db_list_by_tag",
    tier: 0,
    description: "List local mirror records carrying a tag from raw_data tags/matched_tags/all_tags.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "tag"],
      properties: {
        module: { type: "string", enum: ["accounts", "contacts", "deals"] },
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
      }
    }
  },
  {
    name: "db_list_tags",
    tier: 0,
    description: "List tags currently present in the local mirror for a module.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module"],
      properties: {
        module: { type: "string", enum: ["accounts", "contacts", "deals"] },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      }
    }
  },
  {
    name: "db_query",
    tier: 0,
    description:
      "Run a safe structured bulk filter over the Supabase mirror. Use it to resolve task scope quickly; no raw SQL is accepted and live Zoho remains authoritative.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "filters"],
      properties: {
        module: { type: "string", enum: ["accounts", "contacts", "deals"] },
        filters: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "op", "value"],
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["equals", "contains", "starts_with"] },
              value: { type: ["string", "number", "boolean"] }
            }
          }
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
      }
    }
  },
  {
    name: "request_new_tool",
    tier: 0,
    description:
      "File a structured request when the user asks for a capability that is not in the toolbox. Never improvise a missing CRM capability.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "purpose"],
      properties: {
        name: { type: "string", minLength: 2, maxLength: 80 },
        purpose: { type: "string", minLength: 5, maxLength: 1000 },
        example_call: {}
      }
    }
  }
];

export type Tier0ToolName = (typeof TIER0_TOOL_DEFINITIONS)[number]["name"];

export function isTier0Tool(name: string): name is Tier0ToolName {
  return TIER0_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  return schema.parse(args);
}

function filterRecord(record: MirrorRecord, filters: z.infer<typeof dbQuerySchema>["filters"]) {
  return filters.every((filter) => {
    const column = crmFieldToColumn(filter.field);
    const recordValue = normalize(record.data[column] ?? record.raw[filter.field] ?? record.raw[column]);
    const filterValue = normalize(filter.value);
    if (filter.op === "equals") return recordValue === filterValue;
    if (filter.op === "starts_with") return recordValue.startsWith(filterValue);
    return recordValue.includes(filterValue);
  });
}

function exactRecord(records: MirrorRecord[], idOrZohoId: string) {
  const needle = normalize(idOrZohoId);
  return records.find((record) => normalize(record.id) === needle || normalize(record.zoho_id) === needle) ?? null;
}

export async function runTier0Tool({
  call,
  supabase,
  userId
}: {
  call: AgentToolCall;
  supabase: SupabaseClient;
  userId: string;
}) {
  if (call.name === "read_workspace_file") {
    const args = parseArgs(readWorkspaceFileSchema, call.args);
    return readWorkspaceTextFile(workspaceRootFromCwd(process.cwd()), args);
  }

  if (call.name === "db_search_records") {
    const args = parseArgs(dbSearchSchema, call.args);
    const records = await fetchModuleRecords(supabase, args.module);
    const matches = searchMirrorRecords(args.module, records, args.query, args.limit).map(summarizeMirrorRecord);
    return {
      source: "db_mirror",
      freshness_label: "as of last sync",
      module: args.module,
      query: args.query,
      count: matches.length,
      matches
    };
  }

  if (call.name === "db_get_record") {
    const args = parseArgs(dbGetSchema, call.args);
    const records = await fetchModuleRecords(supabase, args.module);
    const record = exactRecord(records, args.id_or_zoho_id);
    return {
      source: "db_mirror",
      freshness_label: "as of last sync",
      module: args.module,
      record: record
        ? {
            ...summarizeMirrorRecord(record),
            raw_data: record.raw
          }
        : null
    };
  }

  if (call.name === "db_list_by_tag") {
    const args = parseArgs(dbTagSchema, call.args);
    const tag = normalize(args.tag);
    const records = await fetchModuleRecords(supabase, args.module);
    const matches = records
      .filter((record) => tagsOf(record).some((candidate) => normalize(candidate) === tag || normalize(candidate).includes(tag)))
      .slice(0, args.limit)
      .map(summarizeMirrorRecord);
    return {
      source: "db_mirror",
      freshness_label: "as of last sync",
      module: args.module,
      tag: args.tag,
      count: matches.length,
      matches
    };
  }

  if (call.name === "db_list_tags") {
    const args = parseArgs(dbListTagsSchema, call.args);
    const records = await fetchModuleRecords(supabase, args.module);
    const counts = new Map<string, number>();
    for (const record of records) {
      for (const tag of tagsOf(record)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tags = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, args.limit)
      .map(([tag, count]) => ({ tag, count }));
    return { source: "db_mirror", module: args.module, tags };
  }

  if (call.name === "db_query") {
    const args = parseArgs(dbQuerySchema, call.args);
    const records = await fetchModuleRecords(supabase, args.module);
    const matches = records.filter((record) => filterRecord(record, args.filters)).slice(0, args.limit);
    return {
      source: "db_mirror",
      freshness_label: "as of last sync",
      module: args.module,
      count: matches.length,
      matches: matches.map(summarizeMirrorRecord)
    };
  }

  if (call.name === "request_new_tool") {
    const args = parseArgs(requestNewToolSchema, call.args);
    const { data, error } = await supabase
      .from("tool_requests")
      .insert({
        user_id: userId,
        name: args.name,
        purpose: args.purpose,
        example_call: args.example_call ?? null,
        status: "open"
      })
      .select("id,status,created_at")
      .single();
    if (error) throw error;
    return {
      filed: true,
      request: data,
      message: `Filed tool request "${args.name}" for review.`
    };
  }

  throw new Error(`Unknown Tier-0 tool: ${call.name}`);
}

export function moduleLabel(module: MirrorModuleKey) {
  return MIRROR_MODULES[module].metaModule;
}
