export type PlanParseInput = {
  command: string;
  files: Array<{
    name: string;
    text: string;
  }>;
  actionBlockCatalog: unknown[];
};

export type ParsedPlan = {
  blocks: Array<{
    slug: string;
    config: Record<string, unknown>;
  }>;
  records: unknown[];
  run_parameters: Record<string, unknown>;
  warnings: string[];
  missing_info: string[];
};

export interface LLMProvider {
  name: string;
  parsePlan(input: PlanParseInput): Promise<ParsedPlan>;
}
