import type {
  AgentPromptMessage,
  AgentToolCall,
  AgentToolDefinition
} from "@/lib/llm/provider";

export function composeAgentInput(messages: AgentPromptMessage[]) {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `TOOL RESULT${message.toolName ? ` (${message.toolName})` : ""}:\n${message.content}`;
      }
      return `${message.role.toUpperCase()}:\n${message.content}`;
    })
    .join("\n\n");
}

export function responsesInputFromText(text: string) {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }]
    }
  ];
}

export function formatResponsesTools(tools: AgentToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function extractResponsesToolCalls(payload: unknown): AgentToolCall[] {
  if (!payload || typeof payload !== "object") return [];
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return [];

  const calls: AgentToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const object = item as Record<string, unknown>;
    if (object.type !== "function_call") continue;
    const name = typeof object.name === "string" ? object.name : "";
    if (!name) continue;
    const id =
      (typeof object.call_id === "string" && object.call_id) ||
      (typeof object.id === "string" && object.id) ||
      crypto.randomUUID();
    calls.push({
      id,
      name,
      args: parseToolArguments(object.arguments)
    });
  }
  return calls;
}
