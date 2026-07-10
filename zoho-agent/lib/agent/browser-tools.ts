import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const browserEvalSchema = z.object({
  purpose: z.string().trim().min(1),
  code: z.string().trim().min(1).max(200_000),
  await_promise: z.boolean().optional(),
  frame_selector: z.string().trim().min(1).max(500).optional()
});

const browserObserveSchema = z.object({
  scope_selector: z.string().trim().min(1).max(500).optional()
});

export type BrowserEvalArgs = z.infer<typeof browserEvalSchema>;

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
    name: "browser_eval",
    tier: 2,
    description:
      "Run model-written JavaScript in the active crm.zoho.com page MAIN world. The code receives `document` as its execution document. To target the email composer body or a dialog rendered in a same-origin iframe, pass frame_selector (a CSS selector for the iframe) and `document` will be bound to that frame's document. `window` and `window.document` stay top-level; when frame_selector is set, read Zoho's #token from window.document before making fetch()-based API calls. Gated only when the user has approvals enabled.",
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
  return name === "browser_eval" || name === "browser_observe";
}

export function validateBrowserToolCall(call: AgentToolCall) {
  if (call.name === "browser_observe") return { ...call, args: browserObserveSchema.parse(call.args ?? {}) };
  if (call.name === "browser_eval") return { ...call, args: browserEvalSchema.parse(call.args) };
  throw new Error(`Unknown browser tool: ${call.name}`);
}
