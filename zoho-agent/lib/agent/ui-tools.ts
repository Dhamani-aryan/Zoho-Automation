import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const selectorOrText = z
  .object({
    selector: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1).optional()
  })
  .refine((value) => Boolean(value.selector) !== Boolean(value.text), {
    message: "Provide exactly one of selector or text."
  });

const waitForStep = selectorOrText.extend({
  type: z.literal("wait_for"),
  timeout_ms: z.number().int().min(250).max(10000).optional()
});

const clickStep = selectorOrText.extend({
  type: z.literal("click")
});

const fillFieldStep = z.object({
  type: z.literal("fill_field"),
  selector: z.string().trim().min(1),
  value: z.string(),
  press_enter: z.boolean().optional()
});

const readFieldStep = z.object({
  type: z.literal("read_field"),
  selector: z.string().trim().min(1)
});

const pressKeyStep = z.object({
  type: z.literal("press_key"),
  key: z.string().trim().min(1).max(40)
});

const confirmTextStep = z.object({
  type: z.literal("confirm_text_present"),
  text: z.string().trim().min(1)
});

const verifyFieldStep = z.object({
  type: z.literal("verify_field"),
  selector: z.string().trim().min(1),
  equals: z.string()
});

const openUrlStep = z.object({
  type: z.literal("open_url"),
  url: z.string().url().refine((value) => new URL(value).hostname === "crm.zoho.com", {
    message: "open_url is limited to crm.zoho.com."
  })
});

const screenshotStep = z.object({
  type: z.literal("screenshot")
});

export const uiStepSchema = z.discriminatedUnion("type", [
  waitForStep,
  clickStep,
  fillFieldStep,
  readFieldStep,
  pressKeyStep,
  confirmTextStep,
  verifyFieldStep,
  openUrlStep,
  screenshotStep
]);

function noSelectorParams(value: unknown) {
  if (!value || typeof value !== "object" || !("selector" in value)) return true;
  const selector = (value as { selector?: unknown }).selector;
  return typeof selector !== "string" || (!selector.includes("{") && !selector.includes("}"));
}

const parameterizedOpenUrlStep = z.object({
  type: z.literal("open_url"),
  url: z.string().trim().min(1)
});

export const uiWorkflowStepSchema = z
  .discriminatedUnion("type", [
    waitForStep,
    clickStep,
    fillFieldStep,
    readFieldStep,
    pressKeyStep,
    confirmTextStep,
    verifyFieldStep,
    parameterizedOpenUrlStep,
    screenshotStep
  ])
  .refine(noSelectorParams, {
    message: "Workflow params cannot be used in selectors."
  });

export const uiStepToolSchema = z.object({
  step: uiStepSchema
});

const workflowParamSchema = z.object({
  name: z.string().trim().min(1).max(60).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  description: z.string().trim().min(1).max(500),
  example: z.string().trim().min(1).max(500)
});

export const saveUiWorkflowSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional().default(""),
  steps: z.array(uiWorkflowStepSchema).min(1).max(100),
  params: z.array(workflowParamSchema).max(20).default([]),
  effect: z.enum(["read", "write"])
});

export type PreparedUiWorkflow = z.infer<typeof saveUiWorkflowSchema>;
export type UiWorkflowStep = PreparedUiWorkflow["steps"][number];
export type UiStep = z.infer<typeof uiStepSchema>;

const workflowParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const runUiWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  params: z.record(z.string(), workflowParamValueSchema).default({})
});

export type RunUiWorkflowArgs = z.infer<typeof runUiWorkflowSchema>;

export const savedUiWorkflowSchema = saveUiWorkflowSchema.extend({
  trusted: z.boolean().default(false),
  version: z.number().int().min(1).default(1)
});

export type SavedUiWorkflow = z.infer<typeof savedUiWorkflowSchema>;

export const UI_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "ui_step",
    tier: 2,
    description:
      "Teach-mode only. Execute exactly one watched Zoho UI step in the user's open crm.zoho.com tab. Only call this while the current chat is in teach mode.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["step"],
      properties: {
        step: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "url"],
              properties: { type: { const: "open_url" }, url: { type: "string" } }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: {
                type: { const: "wait_for" },
                selector: { type: "string" },
                text: { type: "string" },
                timeout_ms: { type: "integer", minimum: 250, maximum: 10000 }
              }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: { type: { const: "click" }, selector: { type: "string" }, text: { type: "string" } }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "selector", "value"],
              properties: {
                type: { const: "fill_field" },
                selector: { type: "string" },
                value: { type: "string" },
                press_enter: { type: "boolean" }
              }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "selector"],
              properties: { type: { const: "read_field" }, selector: { type: "string" } }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "key"],
              properties: { type: { const: "press_key" }, key: { type: "string" } }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "text"],
              properties: { type: { const: "confirm_text_present" }, text: { type: "string" } }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "selector", "equals"],
              properties: { type: { const: "verify_field" }, selector: { type: "string" }, equals: { type: "string" } }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: { type: { const: "screenshot" } }
            }
          ]
        }
      }
    }
  },
  {
    name: "save_ui_workflow",
    tier: 2,
    description:
      "Propose saving the taught UI workflow. Requires a user confirmation card before it is written to the local workflow library.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "steps", "effect"],
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        steps: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: true } },
        params: {
          type: "array",
          maxItems: 20,
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
        },
        effect: { type: "string", enum: ["read", "write"] }
      }
    }
  },
  {
    name: "list_ui_workflows",
    tier: 0,
    description: "List saved UI workflows from the local workflow library.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "run_ui_workflow",
    tier: 1,
    description:
      "Replay a saved UI workflow with named params. Read-effect workflows run unaided; write-effect workflows require the approval gate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string" },
        params: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean"] }
        }
      }
    }
  }
];

export function isUiTool(name: string) {
  return name === "ui_step" || name === "save_ui_workflow" || name === "list_ui_workflows" || name === "run_ui_workflow";
}

export function validateUiToolCall(call: AgentToolCall): AgentToolCall {
  if (!isUiTool(call.name)) throw new Error(`Unknown UI tool: ${call.name}`);
  if (call.name === "ui_step") return { ...call, args: uiStepToolSchema.parse(call.args) };
  if (call.name === "save_ui_workflow") return { ...call, args: prepareUiWorkflow(call.args) };
  if (call.name === "run_ui_workflow") return { ...call, args: runUiWorkflowSchema.parse(call.args) };
  return { ...call, args: {} };
}

export function uiStepTeachModeDecision(teachMode: boolean) {
  return teachMode
    ? { allowed: true, reason: "teach_mode" }
    : { allowed: false, reason: "ui_step requires teach mode" };
}

function stepLooksMutating(step: PreparedUiWorkflow["steps"][number]) {
  return step.type === "click" || step.type === "fill_field" || step.type === "press_key";
}

export function prepareUiWorkflow(args: unknown): PreparedUiWorkflow {
  const prepared = saveUiWorkflowSchema.parse(args);
  if (prepared.effect === "read" && prepared.steps.some(stepLooksMutating)) {
    throw new Error("Workflows containing click, fill_field, or press_key must be saved with effect='write'.");
  }
  return prepared;
}

const PARAM_TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function substituteSlot(value: string, params: Record<string, string | number | boolean>, allowed: Set<string>) {
  return value.replace(PARAM_TOKEN, (match, name: string) => {
    if (!allowed.has(name)) throw new Error(`Unknown workflow param: ${name}.`);
    if (!Object.hasOwn(params, name)) throw new Error(`Missing workflow param: ${name}.`);
    return String(params[name]);
  });
}

function substituteStep(
  step: UiWorkflowStep,
  params: Record<string, string | number | boolean>,
  allowed: Set<string>
): UiStep {
  const next = { ...step } as Record<string, unknown>;
  if (typeof next.url === "string") next.url = substituteSlot(next.url, params, allowed);
  if (typeof next.value === "string") next.value = substituteSlot(next.value, params, allowed);
  if (typeof next.text === "string") next.text = substituteSlot(next.text, params, allowed);
  if (typeof next.equals === "string") next.equals = substituteSlot(next.equals, params, allowed);
  return uiStepSchema.parse(next);
}

export function prepareUiWorkflowReplay(workflowInput: unknown, argsInput: unknown) {
  const workflow = savedUiWorkflowSchema.parse(workflowInput);
  const args = runUiWorkflowSchema.parse(argsInput);
  if (workflow.name !== args.name) throw new Error(`Workflow "${args.name}" was not found.`);

  const allowed = new Set(workflow.params.map((param) => param.name));
  const supplied = Object.keys(args.params);
  const unknown = supplied.filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw new Error(`Unknown workflow param: ${unknown.join(", ")}.`);
  const missing = [...allowed].filter((name) => !Object.hasOwn(args.params, name));
  if (missing.length > 0) throw new Error(`Missing workflow param: ${missing.join(", ")}.`);

  return {
    name: workflow.name,
    description: workflow.description,
    effect: workflow.effect,
    trusted: workflow.trusted,
    version: workflow.version,
    steps: workflow.steps.map((step) => substituteStep(step, args.params, allowed))
  };
}
