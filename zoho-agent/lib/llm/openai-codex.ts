import { bufferToBytea } from "@/lib/crypto/bytea";
import { encryptSecret } from "@/lib/crypto/cred";
import {
  CODEX_CLIENT_ID,
  OPENAI_TOKEN_ENDPOINT,
  decodeChatGptAccountId,
  tokenExpiryIso
} from "@/lib/llm/codex-oauth";
import { extractResponsesText, parsePlanJson } from "@/lib/llm/parse-json";
import type { LLMProvider, ParsedPlan, PlanParseInput } from "@/lib/llm/provider";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const CODEX_RESPONSES_URL =
  process.env.CODEX_RESPONSES_URL ?? "https://chatgpt.com/backend-api/codex/responses";
const CODEX_MODEL = process.env.LLM_MODEL ?? "gpt-5-codex";
const refreshLocks = new Map<string, Promise<CodexToken>>();

type CodexToken = {
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  expiresAt: string;
};

async function refreshCodexToken(userId: string, refreshToken: string): Promise<CodexToken> {
  const existing = refreshLocks.get(userId);
  if (existing) return existing;

  const run = (async () => {
    const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token || !body.refresh_token) {
      throw new Error(body.error_description ?? "ChatGPT credential refresh failed.");
    }

    const encrypted = encryptSecret(body.refresh_token);
    const accountId = decodeChatGptAccountId(body.access_token);
    const expiresAt = tokenExpiryIso(Number(body.expires_in ?? 3600));

    const supabase = createServiceSupabaseClient();
    await supabase?.from("user_llm_credentials").update({
      ciphertext: bufferToBytea(encrypted.ciphertext),
      iv: bufferToBytea(encrypted.iv),
      auth_tag: bufferToBytea(encrypted.authTag),
      account_id: accountId,
      access_token_expires_at: expiresAt,
      status: "active"
    }).eq("user_id", userId);

    return {
      accessToken: body.access_token as string,
      refreshToken: body.refresh_token as string,
      accountId,
      expiresAt
    };
  })();

  refreshLocks.set(userId, run);
  try {
    return await run;
  } finally {
    refreshLocks.delete(userId);
  }
}

export class OpenAICodexProvider implements LLMProvider {
  name = "openai-codex-subscription";

  constructor(
    private readonly userId: string,
    private readonly refreshToken: string,
    private readonly accountId: string | null
  ) {}

  async parsePlan(input: PlanParseInput): Promise<ParsedPlan> {
    const token = await refreshCodexToken(this.userId, this.refreshToken);
    const accountId = token.accountId ?? this.accountId;
    if (!accountId) throw new Error("ChatGPT account id was not present in the Codex credential.");

    const response = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
        "chatgpt-account-id": accountId,
        "OpenAI-Beta": "responses=experimental"
      },
      body: JSON.stringify({
        model: CODEX_MODEL,
        store: false,
        instructions: input.systemPrompt ?? "",
        input: input.command
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Codex parse failed: ${payload.error?.message ?? response.statusText}`);
    }

    return parsePlanJson(extractResponsesText(payload));
  }
}
