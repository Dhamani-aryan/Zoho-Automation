import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";
import { taskOrderMaxToolCalls, taskOrderWallMs } from "./runtime-config";

export type TaskOrderScope = "read" | "write";
export type TaskOrderStatus = "proposed" | "approved" | "rejected" | "expired" | "completed" | "failed";

export type ExpectedChange = {
  record: string;
  action: string;
  detail: string;
};

export type TaskOrderBudget = {
  max_tool_calls: number;
  max_wall_ms: number;
  max_records_touched: number;
};

export type ActiveTaskOrder = {
  id: string;
  session_id: string;
  user_id: string;
  goal: string;
  plan: unknown;
  scope: TaskOrderScope;
  status: TaskOrderStatus;
  budget: TaskOrderBudget;
  decided_at: string | null;
  created_at: string;
};

const expectedChangeSchema = z.object({
  record: z.string().trim().min(1),
  action: z.string().trim().min(1),
  detail: z.string().trim().min(1)
});

const proposeTaskOrderSchema = z.object({
  goal: z.string().trim().min(1),
  plan_summary: z.string().trim().min(1),
  expected_changes: z.array(expectedChangeSchema).max(500).default([]),
  scope: z.enum(["read", "write"])
});

const completeTaskOrderSchema = z.object({
  report: z.union([z.string().trim().min(1), z.record(z.string(), z.unknown())])
});

export type ProposeTaskOrderArgs = z.infer<typeof proposeTaskOrderSchema>;
export type CompleteTaskOrderArgs = z.infer<typeof completeTaskOrderSchema>;

export const TASK_ORDER_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "propose_task_order",
    tier: 2,
    description:
      "Create a task order only for batch work affecting more than 3 distinct records or work the user explicitly asked to run unattended/in the background. Never use it for watched one-record browser work. Read scope auto-approves; write scope shows one approval card for the whole task before any CRM-changing work.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["goal", "plan_summary", "expected_changes", "scope"],
      properties: {
        goal: { type: "string" },
        plan_summary: { type: "string" },
        expected_changes: {
          type: "array",
          maxItems: 500,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["record", "action", "detail"],
            properties: {
              record: { type: "string" },
              action: { type: "string" },
              detail: { type: "string" }
            }
          }
        },
        scope: { type: "string", enum: ["read", "write"] }
      }
    }
  },
  {
    name: "complete_task_order",
    tier: 2,
    description:
      "Complete the active task order with the final report, including counts, per-record status, links, failures, and expected-vs-actual reconciliation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report"],
      properties: {
        report: {
          oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }]
        }
      }
    }
  }
];

export function isTaskOrderTool(name: string) {
  return name === "propose_task_order" || name === "complete_task_order";
}

export function validateTaskOrderToolCall(call: AgentToolCall) {
  if (call.name === "propose_task_order") return { ...call, args: proposeTaskOrderSchema.parse(call.args) };
  if (call.name === "complete_task_order") return { ...call, args: completeTaskOrderSchema.parse(call.args) };
  throw new Error(`Unknown task order tool: ${call.name}`);
}

export function distinctExpectedRecordCount(expectedChanges: ExpectedChange[]) {
  return new Set(expectedChanges.map((change) => change.record.trim().toLowerCase()).filter(Boolean)).size;
}

export function taskOrderProposalDecision(expectedChanges: ExpectedChange[], userRequest: string) {
  const recordCount = distinctExpectedRecordCount(expectedChanges);
  if (recordCount > 3) return { allowed: true as const, reason: "batch", recordCount };

  const explicitlyUnattended =
    /\b(unattended|in the background|background task|while i(?:'m| am) away|without me watching|run overnight|continue on your own)\b/i.test(
      userRequest
    );
  if (explicitlyUnattended) return { allowed: true as const, reason: "unattended", recordCount };

  return {
    allowed: false as const,
    reason: "Task orders are only for more than 3 distinct records or explicitly unattended work. Continue this watched task directly.",
    recordCount
  };
}

export function defaultTaskOrderBudget(expectedChanges: ExpectedChange[]): TaskOrderBudget {
  const expected = distinctExpectedRecordCount(expectedChanges);
  return {
    max_tool_calls: taskOrderMaxToolCalls(),
    max_wall_ms: taskOrderWallMs(),
    max_records_touched: Math.max(expected, Math.ceil(expected * 1.1))
  };
}

export type BudgetDecisionInput = {
  order: Pick<ActiveTaskOrder, "budget" | "decided_at" | "created_at">;
  nowMs: number;
  toolCalls: number;
  recordsTouched: number;
};

export function taskOrderBudgetDecision(input: BudgetDecisionInput): { ok: true } | { ok: false; reason: string } {
  const budget = input.order.budget;
  if (input.toolCalls >= budget.max_tool_calls) {
    return { ok: false, reason: `task order tool-call budget reached (${budget.max_tool_calls})` };
  }
  if (input.recordsTouched > budget.max_records_touched) {
    return { ok: false, reason: `task order record budget exceeded (${budget.max_records_touched})` };
  }
  const startedAt = Date.parse(input.order.decided_at ?? input.order.created_at);
  if (Number.isFinite(startedAt) && input.nowMs - startedAt > budget.max_wall_ms) {
    return { ok: false, reason: `task order wall-clock budget exceeded (${Math.round(budget.max_wall_ms / 60000)} min)` };
  }
  return { ok: true };
}
