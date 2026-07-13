import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const optionalSelectorSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(500).optional()
);

const browserEvalSchema = z.object({
  purpose: z.string().trim().min(1),
  code: z.string().trim().min(1).max(200_000),
  await_promise: z.boolean().optional(),
  frame_selector: optionalSelectorSchema
});

const browserObserveSchema = z.object({
  scope_selector: optionalSelectorSchema
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
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema
  }),
  z.object({
    action: z.literal("type"),
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema,
    value: z.string(),
    press_enter: z.boolean().optional()
  }),
  z.object({
    action: z.literal("remove"),
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema
  }),
  z.object({
    action: z.literal("key"),
    selector: optionalSelectorSchema,
    text: optionalSelectorSchema,
    frame_selector: optionalSelectorSchema,
    key: z.string().trim().min(1).max(40)
  })
]).superRefine((args, ctx) => {
  if ((args.action === "click" || args.action === "type" || args.action === "remove") && !args.selector && !args.text) {
    ctx.addIssue({ code: "custom", message: `browser_input ${args.action} requires selector or text.` });
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
      "Read the current crm.zoho.com page state: URL, title, visible headings, and visible interactive controls. Read-only and ungated.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope_selector: {
          type: "string",
          description: "Optional CSS selector for a dialog, overlay, iframe, or region to observe instead of the full page."
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
      "Dispatch trusted input to the dedicated Zoho tab. For click/type/remove, provide selector or visible text; coordinates are derived from the element rect at action time. For type, the target is clicked, text is inserted, and optional Enter can be pressed. For remove, the extension clicks the target's nearest remove/close/delete affordance for token/chip/tag/pill-style UI. For key, optionally provide selector/text to focus a target first, then dispatch one key such as Backspace, Enter, Tab, or Escape.",
    parameters: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { const: "click" },
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
            selector: { type: "string" },
            text: { type: "string" },
            frame_selector: { type: "string" },
            key: { type: "string" }
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
