export type PlanParseInput = {
  command: string;
  files: Array<{
    name: string;
    text: string;
  }>;
  actionBlockCatalog: unknown[];
  systemPrompt?: string;
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
}
