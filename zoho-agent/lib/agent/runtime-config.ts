import { getEnv } from "../env";

function positiveIntEnv(name: string, fallback: number) {
  const raw = getEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const AGENT_DEFAULT_MAX_TOOL_CALLS = 15;
export const AGENT_DEFAULT_TURN_TIMEOUT_MS = 3 * 60 * 1000;
export const AGENT_DEFAULT_JOB_TIMEOUT_MS = 90 * 1000;
export const AGENT_DEFAULT_EXTENSION_LIVE_MS = 120 * 1000;
export const TASK_ORDER_DEFAULT_MAX_TOOL_CALLS = 200;
export const TASK_ORDER_DEFAULT_WALL_MS = 45 * 60 * 1000;
export const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export function agentMaxToolCalls() {
  return positiveIntEnv("AGENT_MAX_TOOL_CALLS", AGENT_DEFAULT_MAX_TOOL_CALLS);
}

export function agentTurnTimeoutMs() {
  return positiveIntEnv("AGENT_TURN_TIMEOUT_MS", AGENT_DEFAULT_TURN_TIMEOUT_MS);
}

export function agentJobTimeoutMs() {
  return positiveIntEnv("AGENT_JOB_TIMEOUT_MS", AGENT_DEFAULT_JOB_TIMEOUT_MS);
}

export function extensionLiveMs() {
  return positiveIntEnv("EXTENSION_LIVE_MS", AGENT_DEFAULT_EXTENSION_LIVE_MS);
}

export function taskOrderMaxToolCalls() {
  return positiveIntEnv("TASK_ORDER_MAX_TOOL_CALLS", TASK_ORDER_DEFAULT_MAX_TOOL_CALLS);
}

export function taskOrderWallMs() {
  return positiveIntEnv("TASK_ORDER_WALL_MS", TASK_ORDER_DEFAULT_WALL_MS);
}

export function codexResponsesUrl() {
  return getEnv("CODEX_RESPONSES_URL") ?? DEFAULT_CODEX_RESPONSES_URL;
}

export function llmModel(defaultModel: string) {
  return getEnv("LLM_MODEL") ?? defaultModel;
}
