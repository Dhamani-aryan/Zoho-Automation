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

export const uiStepToolSchema = z.object({
  step: uiStepSchema
});

export type UiStep = z.infer<typeof uiStepSchema>;

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
  }
];

export function isUiTool(name: string) {
  return name === "ui_step";
}

export function validateUiToolCall(call: AgentToolCall): AgentToolCall {
  if (!isUiTool(call.name)) throw new Error(`Unknown UI tool: ${call.name}`);
  return { ...call, args: uiStepToolSchema.parse(call.args) };
}

export function uiStepTeachModeDecision(teachMode: boolean) {
  return teachMode
    ? { allowed: true, reason: "teach_mode" }
    : { allowed: false, reason: "ui_step requires teach mode" };
}
