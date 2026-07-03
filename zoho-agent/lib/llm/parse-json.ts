import type { ParsedPlan } from "@/lib/llm/provider";

export function emptyPlan(message: string): ParsedPlan {
  return {
    intent_summary: "Command needs more information",
    run_kind: "write",
    blocks: [],
    record_selector: {
      mode: "names",
      module: "deals",
      values: []
    },
    run_parameters: {},
    warnings: [],
    missing_info: [message]
  };
}

export function parsePlanJson(text: string): ParsedPlan {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  const jsonText = jsonStart >= 0 && jsonEnd >= jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
  return JSON.parse(jsonText) as ParsedPlan;
}

export function extractResponsesText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const object = payload as Record<string, unknown>;
  if (typeof object.output_text === "string") return object.output_text;

  const output = object.output;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const contentObject = contentItem as Record<string, unknown>;
      if (typeof contentObject.text === "string") chunks.push(contentObject.text);
    }
  }

  return chunks.join("\n");
}
