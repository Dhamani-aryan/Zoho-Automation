import { composeUserInput, extractResponsesText, parsePlanJson } from "@/lib/llm/parse-json";
import type { AgentModelResult, AgentRunToolsInput, LLMProvider, ParsedPlan, PlanParseInput } from "@/lib/llm/provider";
import {
  extractResponsesToolCalls,
  formatResponsesTools,
  responsesInputFromMessages
} from "@/lib/llm/tool-calls";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 90000;

async function postResponses(apiKey: string, body: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${(payload as { error?: { message?: string } }).error?.message ?? response.statusText}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`OpenAI did not respond within ${OPENAI_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export class OpenAIKeyProvider implements LLMProvider {
  name = "openai-api-key";

  constructor(private readonly apiKey: string) {}

  async parsePlan(input: PlanParseInput): Promise<ParsedPlan> {
    const payload = await postResponses(this.apiKey, {
        model: LLM_MODEL,
        store: false,
        temperature: 0.1,
        instructions: input.systemPrompt ?? "",
        input: composeUserInput(input)
    });

    return parsePlanJson(extractResponsesText(payload));
  }

  async runTools(input: AgentRunToolsInput): Promise<AgentModelResult> {
    const payload = await postResponses(this.apiKey, {
      model: LLM_MODEL,
      store: false,
      temperature: 0.1,
      instructions: input.instructions,
      input: responsesInputFromMessages(input.messages),
      tools: formatResponsesTools(input.tools),
      tool_choice: "auto",
      parallel_tool_calls: false
    });

    return {
      text: extractResponsesText(payload),
      toolCalls: extractResponsesToolCalls(payload)
    };
  }
}
