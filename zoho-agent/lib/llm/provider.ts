export type PlanParseInput = {
  command: string;
  files: Array<{
    name: string;
    text: string;
  }>;
  actionBlockCatalog: unknown[];
  systemPrompt?: string;
};

export type AgentPromptMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tier: 0 | 1 | 2;
};

export type AgentToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type AgentRunToolsInput = {
  instructions: string;
  messages: AgentPromptMessage[];
  tools: AgentToolDefinition[];
};

export type AgentModelResult = {
  text: string;
  toolCalls: AgentToolCall[];
};

export type ParsedPlan = {
  intent_summary: string;
  run_kind: "read" | "write";
  blocks: Array<{
    slug: string;
    config: Record<string, unknown>;
  }>;
  record_selector: {
    mode: "tag" | "ids" | "names" | "file" | "filter";
    module: "deals" | "contacts" | "accounts";
    tag?: string;
    values?: string[];
    filter?: {
      field: string;
      op: "equals" | "contains" | "starts_with";
      value: string;
    };
  };
  run_parameters: Record<string, unknown>;
  warnings: string[];
  missing_info: string[];
};

export interface LLMProvider {
  name: string;
  parsePlan(input: PlanParseInput): Promise<ParsedPlan>;
  runTools(input: AgentRunToolsInput): Promise<AgentModelResult>;
}
