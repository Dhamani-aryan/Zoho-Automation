import { getEnv } from "@/lib/env";
import type { LLMProvider } from "@/lib/llm/provider";

class MissingProvider implements LLMProvider {
  name = "missing-openai-key";

  async parsePlan() {
    return {
      blocks: [],
      records: [],
      run_parameters: {},
      warnings: ["OPENAI_API_KEY is not configured yet."],
      missing_info: ["Add OPENAI_API_KEY during Phase 2 before enabling command parsing."]
    };
  }
}

export function getLLMProvider(): LLMProvider {
  const apiKey = getEnv("OPENAI_API_KEY");

  if (!apiKey) {
    return new MissingProvider();
  }

  throw new Error("OpenAIProvider not implemented — Phase 2");
}
