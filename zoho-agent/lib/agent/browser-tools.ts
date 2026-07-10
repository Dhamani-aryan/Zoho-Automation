import { z } from "zod";
import type { AgentToolCall, AgentToolDefinition } from "@/lib/llm/provider";

const browserEvalSchema = z.object({
  purpose: z.string().trim().min(1),
  code: z.string().trim().min(1).max(200_000),
  await_promise: z.boolean().optional()
});

export type BrowserEvalArgs = z.infer<typeof browserEvalSchema>;

export const BROWSER_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "browser_eval",
    tier: 2,
    description:
      "Run model-written JavaScript in the active crm.zoho.com page MAIN world. Requires an approved task order or a per-call approval card showing the full purpose and code.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["purpose", "code"],
      properties: {
        purpose: { type: "string" },
        code: { type: "string" },
        await_promise: { type: "boolean" }
      }
    }
  }
];

export function isBrowserTool(name: string) {
  return name === "browser_eval";
}

export function validateBrowserToolCall(call: AgentToolCall) {
  if (call.name === "browser_eval") return { ...call, args: browserEvalSchema.parse(call.args) };
  throw new Error(`Unknown browser tool: ${call.name}`);
}
