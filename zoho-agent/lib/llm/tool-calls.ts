import type {
  AgentPromptMessage,
  AgentToolCall,
  AgentToolDefinition
} from "@/lib/llm/provider";

export function composeAgentInput(messages: AgentPromptMessage[]) {
  return messages
    .map((message) => {
      if (message.role === "tool_call") {
        return `ASSISTANT TOOL CALL${message.toolName ? ` (${message.toolName})` : ""}:\n${JSON.stringify(message.args ?? {}, null, 2)}`;
      }
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

export function responsesInputFromMessages(messages: AgentPromptMessage[]) {
  if (process.env.AGENT_FLAT_TRANSCRIPT === "1") {
    return responsesInputFromText(composeAgentInput(messages));
  }

  const toolCallIds = new Set(
    messages
      .filter((message) => message.role === "tool_call" && message.callId)
      .map((message) => message.callId as string)
  );
  const toolOutputIds = new Set(
    messages
      .filter((message) => message.role === "tool" && message.callId)
      .map((message) => message.callId as string)
  );
  const completeToolCallIds = new Set([...toolCallIds].filter((callId) => toolOutputIds.has(callId)));

  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "tool_call") {
      if (!message.toolName || !message.callId || !completeToolCallIds.has(message.callId)) continue;
      input.push({
        type: "function_call",
        call_id: message.callId,
        name: message.toolName,
        arguments: JSON.stringify(message.args ?? {})
      });
      continue;
    }

    if (message.role === "tool") {
      if (!message.callId || !completeToolCallIds.has(message.callId)) {
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `TOOL RESULT${message.toolName ? ` (${message.toolName})` : ""}:\n${message.content}` }]
        });
        continue;
      }
      input.push({
        type: "function_call_output",
        call_id: message.callId,
        output: message.content
      });
      continue;
    }

    input.push({
      type: "message",
      role: message.role,
      content: [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content
        }
      ]
    });
  }

  if (input.length === 0) return responsesInputFromText("");
  return input;
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
