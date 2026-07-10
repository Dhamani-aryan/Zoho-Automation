import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const modules = ["Accounts", "Contacts", "Deals"] as const;

const moduleSchema = z.preprocess((value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "accounts") return "Accounts";
  if (raw === "contacts") return "Contacts";
  if (raw === "deals") return "Deals";
  return value;
}, z.enum(modules));

const undoRecordSchema = z.object({
  module: moduleSchema,
  zoho_id: z.string().trim().min(1),
  fields: z.array(z.string().trim().min(1)).optional()
});

const undoTaskSchema = z.object({
  task_order_id: z.string().trim().uuid()
});

export type UndoRecordArgs = z.infer<typeof undoRecordSchema>;
export type UndoTaskArgs = z.infer<typeof undoTaskSchema>;

export const UNDO_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "undo_record",
    tier: 2,
    description:
      "Undo the latest logged field/owner/tag change for one Zoho record using recorded before-values. Scheduled emails are not revertible; report their manual Scheduled-tab path instead.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module", "zoho_id"],
      properties: {
        module: { type: "string", enum: modules },
        zoho_id: { type: "string" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional API field names to revert. Omit to revert all logged fields for the latest change."
        }
      }
    }
  },
  {
    name: "undo_task",
    tier: 2,
    description:
      "Undo all revertible field/owner/tag writes logged under a task order. Non-revertible scheduled emails are reported with the manual Scheduled-tab path.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_order_id"],
      properties: {
        task_order_id: { type: "string" }
      }
    }
  }
];

export function isUndoTool(name: string) {
  return name === "undo_record" || name === "undo_task";
}

export function validateUndoToolCall(call: AgentToolCall) {
  if (call.name === "undo_record") return { ...call, args: undoRecordSchema.parse(call.args) };
  if (call.name === "undo_task") return { ...call, args: undoTaskSchema.parse(call.args) };
  throw new Error(`Unknown undo tool: ${call.name}`);
}
