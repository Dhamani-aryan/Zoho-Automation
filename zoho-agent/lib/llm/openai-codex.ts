import { bufferToBytea } from "@/lib/crypto/bytea";
import { encryptSecret } from "@/lib/crypto/cred";
import {
  CODEX_CLIENT_ID,
  OPENAI_TOKEN_ENDPOINT,
  decodeChatGptAccountId,
  tokenExpiryIso
} from "@/lib/llm/codex-oauth";
import { composeUserInput, extractResponsesText, parsePlanJson } from "@/lib/llm/parse-json";
import type {
  AgentModelResult,
  AgentRunToolsInput,
  AgentToolCall,
  LLMProvider,
  ParsedPlan,
  PlanParseInput
} from "@/lib/llm/provider";
import {
  extractResponsesToolCalls,
  formatResponsesTools,
  parseToolArguments,
  responsesInputFromMessages
} from "@/lib/llm/tool-calls";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const CODEX_RESPONSES_URL =
  process.env.CODEX_RESPONSES_URL ?? "https://chatgpt.com/backend-api/codex/responses";
// Must be a model id from the pi reference's openai-codex.models.ts registry.
// "gpt-5-codex" is NOT in the current registry and the backend rejects it.
const CODEX_MODEL = process.env.LLM_MODEL ?? "gpt-5.4";
const CODEX_TIMEOUT_MS = 90000;
const refreshLocks = new Map<string, Promise<CodexToken>>();

// The Codex backend only serves streaming (SSE) responses. Buffer the whole
// stream, then pull the final response object from the `response.completed`
// event (falling back to accumulated output_text deltas).
function extractSseOutput(sseText: string): {
  completed: unknown;
  deltaText: string;
  itemText: string;
  toolCalls: AgentToolCall[];
  failure: string | null;
  eventSummary: string;
} {
  let completed: unknown = null;
  let failure: string | null = null;
  const deltas: string[] = [];
  const itemTexts: string[] = [];
  const eventCounts = new Map<string, number>();
  const streamedToolItems = new Map<string, { id: string; callId: string; name: string; args: string }>();

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof event.type === "string" ? event.type : "unknown";
    eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);

    if (type === "response.completed" && event.response) {
      completed = event.response;
    } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    } else if (
      type === "response.output_item.added" ||
      (type === "response.output_item.done" &&
        (event.item as Record<string, unknown> | undefined)?.type === "function_call")
    ) {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const id =
          (typeof item.id === "string" && item.id) ||
          (typeof event.item_id === "string" && event.item_id) ||
          crypto.randomUUID();
        const existing = streamedToolItems.get(id);
        streamedToolItems.set(id, {
          id,
          callId: (typeof item.call_id === "string" && item.call_id) || existing?.callId || id,
          name: (typeof item.name === "string" && item.name) || existing?.name || "",
          args: typeof item.arguments === "string" ? item.arguments : existing?.args ?? ""
        });
      }
    } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      if (itemId) {
        const existing = streamedToolItems.get(itemId) ?? { id: itemId, callId: itemId, name: "", args: "" };
        existing.args += event.delta;
        streamedToolItems.set(itemId, existing);
      }
    } else if (type === "response.function_call_arguments.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : "";
      const args = typeof event.arguments === "string" ? event.arguments : undefined;
      if (itemId && args !== undefined) {
        const existing = streamedToolItems.get(itemId) ?? { id: itemId, callId: itemId, name: "", args: "" };
        existing.args = args;
        streamedToolItems.set(itemId, existing);
      }
    } else if (type === "response.output_item.done" || type === "response.content_part.done") {
      // Alternate places the final text can appear, depending on backend version.
      const item = (event.item ?? event.part) as
        | { content?: Array<{ text?: unknown; refusal?: unknown }>; text?: unknown }
        | undefined;
      if (typeof item?.text === "string") itemTexts.push(item.text);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string") itemTexts.push(part.text);
          if (typeof part?.refusal === "string") failure = `Model refused: ${part.refusal}`;
        }
      }
    } else if (type === "response.failed" || type === "error") {
      const response = event.response as { error?: { message?: string } } | undefined;
      failure =
        response?.error?.message ??
        (typeof (event as { message?: unknown }).message === "string"
          ? ((event as { message?: string }).message as string)
          : "Codex stream reported a failure.");
    }
  }

  const eventSummary =
    [...eventCounts.entries()].map(([type, count]) => `${type}×${count}`).join(", ") || "no events parsed";

  const completedToolCalls = completed ? extractResponsesToolCalls(completed) : [];
  const seenToolIds = new Set(completedToolCalls.map((call) => call.id));
  const streamedToolCalls = [...streamedToolItems.values()]
    .filter((item) => item.name && !seenToolIds.has(item.callId))
    .map((item) => ({
      id: item.callId,
      name: item.name,
      args: parseToolArguments(item.args)
    }));

  return {
    completed,
    deltaText: deltas.join(""),
    itemText: itemTexts.join("\n"),
    toolCalls: [...completedToolCalls, ...streamedToolCalls],
    failure,
    eventSummary
  };
}

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

    const sessionId = crypto.randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CODEX_TIMEOUT_MS);

    let response: Response;
    try {
      // Header set and body shape mirror pi's openai-codex-responses api
      // (originator/User-Agent/session-id matter — diffs cause 403s).
      response = await fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "chatgpt-account-id": accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: "pi",
          "User-Agent": "pi (zoho-agent)",
          "session-id": sessionId,
          "x-client-request-id": sessionId
        },
        body: JSON.stringify({
          model: CODEX_MODEL,
          store: false,
          stream: true,
          instructions: input.systemPrompt ?? "",
          // The Codex backend requires the list form of `input` ("Input must
          // be a list"), unlike api.openai.com which also accepts a string.
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: composeUserInput(input) }]
            }
          ],
          text: { verbosity: "low" }
        })
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new Error(
        error instanceof Error && error.name === "AbortError"
          ? `Codex did not respond within ${CODEX_TIMEOUT_MS / 1000}s.`
          : "Could not reach the Codex backend."
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let detail = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string }; detail?: string };
        detail = parsed.error?.message ?? parsed.detail ?? detail;
      } catch {
        // keep raw snippet
      }
      throw new Error(`Codex parse failed (status ${response.status}, model ${CODEX_MODEL}): ${detail}`);
    }

    const { completed, deltaText, itemText, failure, eventSummary } = extractSseOutput(raw);
    if (failure) throw new Error(`Codex parse failed: ${failure}`);

    const completedText = completed ? extractResponsesText(completed) : "";
    const outputText = [completedText, deltaText, itemText].find((text) => text.trim()) ?? "";
    if (!outputText.trim()) {
      // Dump the raw stream to the server log so the actual shape is visible.
      console.error(
        "[codex-parse] empty output. events:",
        eventSummary,
        "\nstream head:\n",
        raw.slice(0, 1500),
        "\nstream tail:\n",
        raw.slice(-1500)
      );
      throw new Error(
        `Codex returned no output text. SSE events seen: ${eventSummary}. Full stream logged to the dev terminal as [codex-parse].`
      );
    }

    return parsePlanJson(outputText);
  }

  async runTools(input: AgentRunToolsInput): Promise<AgentModelResult> {
    const token = await refreshCodexToken(this.userId, this.refreshToken);
    const accountId = token.accountId ?? this.accountId;
    if (!accountId) throw new Error("ChatGPT account id was not present in the Codex credential.");

    const sessionId = crypto.randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CODEX_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "chatgpt-account-id": accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: "pi",
          "User-Agent": "pi (zoho-agent)",
          "session-id": sessionId,
          "x-client-request-id": sessionId
        },
        body: JSON.stringify({
          model: CODEX_MODEL,
          store: false,
          stream: true,
          instructions: input.instructions,
          input: responsesInputFromMessages(input.messages),
          tools: formatResponsesTools(input.tools),
          tool_choice: "auto",
          parallel_tool_calls: false,
          text: { verbosity: "low" }
        })
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new Error(
        error instanceof Error && error.name === "AbortError"
          ? `Codex did not respond within ${CODEX_TIMEOUT_MS / 1000}s.`
          : "Could not reach the Codex backend."
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let detail = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string }; detail?: string };
        detail = parsed.error?.message ?? parsed.detail ?? detail;
      } catch {
        // keep raw snippet
      }
      throw new Error(`Codex tool run failed (status ${response.status}, model ${CODEX_MODEL}): ${detail}`);
    }

    const { completed, deltaText, itemText, toolCalls, failure, eventSummary } = extractSseOutput(raw);
    if (failure) throw new Error(`Codex tool run failed: ${failure}`);

    const completedText = completed ? extractResponsesText(completed) : "";
    const text = [completedText, deltaText, itemText].find((candidate) => candidate.trim()) ?? "";
    if (!text.trim() && toolCalls.length === 0) {
      console.error(
        "[codex-tools] empty output. events:",
        eventSummary,
        "\nstream head:\n",
        raw.slice(0, 1500),
        "\nstream tail:\n",
        raw.slice(-1500)
      );
      throw new Error(
        `Codex returned no text or tool calls. SSE events seen: ${eventSummary}. Full stream logged to the dev terminal as [codex-tools].`
      );
    }

    return { text, toolCalls };
  }
}
