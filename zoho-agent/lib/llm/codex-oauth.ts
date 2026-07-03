export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
export const CODEX_DEVICE_USER_CODE_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_TOKEN_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/token";
export const OPENAI_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_REDIRECT_URI =
  "https://auth.openai.com/api/accounts/deviceauth/callback";

export function decodeChatGptAccountId(accessToken: string) {
  const [, payload] = accessToken.split(".");
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    return decoded["https://api.openai.com/auth.chatgpt_account_id"] ?? null;
  } catch {
    return null;
  }
}

export function tokenExpiryIso(expiresInSeconds: number) {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}
