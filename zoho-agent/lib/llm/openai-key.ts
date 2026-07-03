import { extractResponsesText, parsePlanJson } from "@/lib/llm/parse-json";
import type { LLMProvider, ParsedPlan, PlanParseInput } from "@/lib/llm/provider";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4.1-mini";

export class OpenAIKeyProvider implements LLMProvider {
  name = "openai-api-key";

  constructor(private readonly apiKey: string) {}

  async parsePlan(input: PlanParseInput): Promise<ParsedPlan> {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        store: false,
        temperature: 0.1,
        instructions: input.systemPrompt ?? "",
        input: input.command
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`OpenAI parse failed: ${payload.error?.message ?? response.statusText}`);
    }

    return parsePlanJson(extractResponsesText(payload));
  }
}
