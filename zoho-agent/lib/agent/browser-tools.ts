import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const optionalSelectorSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(500).optional()
);

const optionalElementRefSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().regex(/^@e\d+$/, "Element ref must look like @e1.").optional()
);

const browserEvalSchema = z.object({
  purpose: z.string().trim().min(1),
  code: z.string().trim().min(1).max(200_000),
  await_promise: z.boolean().optional(),
  frame_selector: optionalSelectorSchema
});

const browserObserveSchema = z.object({
  scope_selector: optionalSelectorSchema,
  target_selector: optionalSelectorSchema,
  target_text: optionalSelectorSchema
});

const browserNavigateSchema = z.object({
  url: z.string().trim().url().refine((value) => {
    try {
      return new URL(value).hostname === "crm.zoho.com";
    } catch {
      return false;
    }
  }, "browser_navigate is limited to crm.zoho.com URLs.")
});

const browserScreenshotSchema = z.object({});

const browserInputSchema = z.union([
  z.object({
    action: z.literal("click"),
    ref: optionalElementRefSchema,
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema
  }),
  z.object({
    action: z.literal("type"),
    ref: optionalElementRefSchema,
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema,
    value: z.string(),
    press_enter: z.boolean().optional()
  }),
  z.object({
    action: z.literal("remove"),
    ref: optionalElementRefSchema,
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema
  }),
  z.object({
    action: z.literal("key"),
    ref: optionalElementRefSchema,
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema,
    key: z.string().trim().min(1).max(40),
    repeat: z.number().int().min(1).max(20).optional()
  }),
  z.object({
    action: z.enum(["hover", "focus", "clear", "check", "uncheck"]),
    ref: optionalElementRefSchema,
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema
  }),
  z.object({
    action: z.literal("select"),
    ref: optionalElementRefSchema,
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema,
    value: z.string()
  })
]).superRefine((args, ctx) => {
  if (args.action !== "key" && !args.ref && !args.selector && !args.text) {
    ctx.addIssue({ code: "custom", message: `browser_input ${args.action} requires ref, selector, or text.` });
  }
});

export type BrowserEvalArgs = z.infer<typeof browserEvalSchema>;
export type BrowserNavigateArgs = z.infer<typeof browserNavigateSchema>;
export type BrowserInputArgs = z.infer<typeof browserInputSchema>;

export const BROWSER_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "browser_observe",
    tier: 1,
    description:
      "Capture the current crm.zoho.com page as a ranked interactive snapshot. Returns stable @eN refs with roles, accessible names, primary/fallback selectors, frame scope, state, and geometry. Use those refs with browser_input. Pass target_selector or target_text for extra local descendants, siblings, hit targets, and pseudo-element content. Read-only and ungated.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope_selector: {
          type: "string",
          description: "Optional CSS selector for a dialog, overlay, iframe, or region to observe instead of the full page."
        },
        target_selector: {
          type: "string",
          description: "Optional CSS selector for an exact element to inspect before interacting with it."
        },
        target_text: {
          type: "string",
          description: "Optional visible text used to find the smallest matching element and inspect its local controls before interacting."
        }
      }
    }
  },
  {
    name: "browser_navigate",
    tier: 1,
    description:
      "Navigate the dedicated background Zoho tab to a crm.zoho.com URL without focusing or activating Chrome. Use known canonical CRM record URLs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string" }
      }
    }
  },
  {
    name: "browser_screenshot",
    tier: 1,
    description:
      "Capture a JPEG screenshot of the dedicated Zoho tab through CDP, capped at 500 KB. Use only when visual evidence materially helps verification.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "browser_input",
    tier: 2,
    description:
      "Act on the current Zoho page using a fresh browser_observe snapshot. Prefer an @eN ref; the extension resolves its primary and fallback selectors and rejects stale refs. Supports click, type, key, hover, focus, clear, select, check, uncheck, and semantic remove. Trusted CDP is used for pointer/keyboard input. key repeat sends 1-20 presses. Observe again afterward to verify state.",
    parameters: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { const: "click" },
            ref: { type: "string", description: "Fresh @eN reference from browser_observe." },
            selector: { type: "string" },
            text: { type: "string" },
            frame_selector: { type: "string" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "value"],
          properties: {
            action: { const: "type" },
            ref: { type: "string", description: "Fresh @eN reference from browser_observe." },
            selector: { type: "string" },
            text: { type: "string" },
            frame_selector: { type: "string" },
            value: { type: "string" },
            press_enter: { type: "boolean" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { const: "remove" },
            ref: { type: "string", description: "Fresh @eN reference from browser_observe." },
            selector: { type: "string" },
            text: { type: "string" },
            frame_selector: { type: "string" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "key"],
          properties: {
            action: { const: "key" },
            ref: { type: "string", description: "Fresh @eN reference from browser_observe." },
            selector: { type: "string" },
            text: { type: "string" },
            frame_selector: { type: "string" },
            key: { type: "string" },
            repeat: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "Number of trusted key presses to dispatch after focusing the target. Defaults to 1."
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { enum: ["hover", "focus", "clear", "check", "uncheck"] },
            ref: { type: "string", description: "Fresh @eN reference from browser_observe." },
            selector: { type: "string" },
            text: { type: "string" },
            frame_selector: { type: "string" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "value"],
          properties: {
            action: { const: "select" },
            ref: { type: "string", description: "Fresh @eN reference from browser_observe." },
            selector: { type: "string" },
            text: { type: "string" },
            frame_selector: { type: "string" },
            value: { type: "string" }
          }
        }
      ]
    }
  },
  {
    name: "browser_eval",
    tier: 2,
    description:
      "Run model-written JavaScript in the active crm.zoho.com page MAIN world. The code receives `document` as its execution document. To target the email composer body or a dialog rendered in a same-origin iframe, pass frame_selector (a CSS selector for the iframe) and `document` will be bound to that frame's document. `window` and `window.document` stay top-level; when frame_selector is set, read Zoho's #token from window.document before making fetch()-based API calls. In the Zoho email editor, never replace #editorDiv innerHTML/textContent or call replaceChildren: insert body nodes before #ecw_signature and verify the signature remains. The extension restores and rejects an eval that removes an existing signature. Every eval that can change state must return a JSON-serializable read-back object; no return is explicitly unverified and requires browser_observe before retry or completion. Gated only when the user has approvals enabled.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["purpose", "code"],
      properties: {
        purpose: { type: "string" },
        code: { type: "string" },
        await_promise: { type: "boolean" },
        frame_selector: {
          type: "string",
          description: "Optional CSS selector for a same-origin iframe (e.g. the Zoho email composer body) whose document the code should run against."
        }
      }
    }
  }
];

export function isBrowserTool(name: string) {
  return (
    name === "browser_eval" ||
    name === "browser_observe" ||
    name === "browser_navigate" ||
    name === "browser_screenshot" ||
    name === "browser_input"
  );
}

export function validateBrowserToolCall(call: AgentToolCall) {
  if (call.name === "browser_observe") return { ...call, args: browserObserveSchema.parse(call.args ?? {}) };
  if (call.name === "browser_navigate") return { ...call, args: browserNavigateSchema.parse(call.args) };
  if (call.name === "browser_screenshot") return { ...call, args: browserScreenshotSchema.parse(call.args ?? {}) };
  if (call.name === "browser_input") return { ...call, args: browserInputSchema.parse(call.args) };
  if (call.name === "browser_eval") return { ...call, args: browserEvalSchema.parse(call.args) };
  throw new Error(`Unknown browser tool: ${call.name}`);
}
