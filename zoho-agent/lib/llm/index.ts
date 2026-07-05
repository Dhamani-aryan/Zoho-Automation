import { emptyPlan } from "@/lib/llm/parse-json";
import { OpenAICodexProvider } from "@/lib/llm/openai-codex";
import { OpenAIKeyProvider } from "@/lib/llm/openai-key";
import type { AgentModelResult, LLMProvider } from "@/lib/llm/provider";
import { resolveCredential } from "@/lib/llm/resolve-credential";

class MissingProvider implements LLMProvider {
  name = "missing-user-credential";

  constructor(private readonly message: string) {}

  async parsePlan() {
    return emptyPlan(this.message);
  }

  async runTools(): Promise<AgentModelResult> {
    throw new Error(this.message);
  }
}

export async function getLLMProviderForUser(userId: string): Promise<LLMProvider> {
  const credential = await resolveCredential(userId);

  if (credential.kind === "missing") {
    return new MissingProvider(credential.message);
  }

  if (credential.kind === "openai_api_key") {
    return new OpenAIKeyProvider(credential.apiKey);
  }

  return new OpenAICodexProvider(userId, credential.refreshToken, credential.accountId);
}
