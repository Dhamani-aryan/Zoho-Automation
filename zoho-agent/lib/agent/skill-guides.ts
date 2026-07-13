import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const guideParamSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  example: z.string().trim().min(1)
});

const saveSkillGuideSchema = z.object({
  name: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  preconditions: z.string().default(""),
  method_api: z.string().default(""),
  method_ui: z.string().default(""),
  gotchas: z.string().default(""),
  verification: z.string().trim().min(1),
  stop_conditions: z.string().trim().min(1),
  params: z.array(guideParamSchema).max(50).default([])
});

const readSkillGuideSchema = z.object({
  name: z.string().trim().min(1)
});

export type SaveSkillGuideArgs = z.infer<typeof saveSkillGuideSchema>;

export const SKILL_GUIDE_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "list_skill_guides",
    tier: 0,
    description: "List available skill guides by name, intent, params, and version.",
    parameters: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "read_skill_guide",
    tier: 0,
    description: "Read one skill guide by exact name before running that class of task.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } }
    }
  },
  {
    name: "save_skill_guide",
    tier: 1,
    description:
      "Save a new reusable skill guide or update the existing guide with the same exact name. Supply the complete retained guide when updating; add corrections to Gotchas instead of creating duplicates. Guides store METHOD only, never run-specific data: put every value that varies (e.g. deal_id, account_name, contact_email, date, subject, body) into params, and write method_api/method_ui to resolve those identity slots via db_search_records/db_query first and a zoho_api GET to confirm before any write. Saves directly and audits the version.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "intent", "verification", "stop_conditions"],
      properties: {
        name: { type: "string" },
        intent: { type: "string" },
        preconditions: { type: "string" },
        method_api: { type: "string" },
        method_ui: { type: "string" },
        gotchas: { type: "string" },
        verification: { type: "string" },
        stop_conditions: { type: "string" },
        params: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "description", "example"],
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              example: { type: "string" }
            }
          }
        }
      }
    }
  }
];

export function isSkillGuideTool(name: string) {
  return name === "list_skill_guides" || name === "read_skill_guide" || name === "save_skill_guide";
}

export function validateSkillGuideToolCall(call: AgentToolCall) {
  if (call.name === "list_skill_guides") return { ...call, args: {} };
  if (call.name === "read_skill_guide") return { ...call, args: readSkillGuideSchema.parse(call.args) };
  if (call.name === "save_skill_guide") return { ...call, args: saveSkillGuideSchema.parse(call.args) };
  throw new Error(`Unknown skill guide tool: ${call.name}`);
}
