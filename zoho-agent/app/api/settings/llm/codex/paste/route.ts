import { NextResponse } from "next/server";
import { bufferToBytea } from "@/lib/crypto/bytea";
import { credentialEncryptionReady, encryptSecret } from "@/lib/crypto/cred";
import { requireApiRole } from "@/lib/auth/guards";
import {
  CODEX_CLIENT_ID,
  OPENAI_TOKEN_ENDPOINT,
  decodeChatGptAccountId,
  tokenExpiryIso
} from "@/lib/llm/codex-oauth";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const REFRESH_TIMEOUT_MS = 15000;

type RefreshBody = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error_description?: string;
};

function extractRefreshToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const tokens = (parsed.tokens ?? parsed) as Record<string, unknown>;
      const refreshToken = tokens.refresh_token ?? parsed.refresh_token;
      return typeof refreshToken === "string" && refreshToken.trim() ? refreshToken.trim() : null;
    } catch {
      return null;
    }
  }

  return trimmed;
}

async function refreshCodexCredential(refreshToken: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID
      })
    });
    const body = (await response.json().catch(() => ({}))) as RefreshBody;
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const raw = typeof body?.credential === "string" ? body.credential : "";
  const refreshToken = extractRefreshToken(raw);
  if (!refreshToken) {
    return NextResponse.json(
      { error: "Paste the contents of your ~/.codex/auth.json or its refresh_token." },
      { status: 400 }
    );
  }

  // Fail on server misconfiguration BEFORE the validation refresh below —
  // that refresh rotates the user's refresh token at OpenAI, so crashing
  // after it would burn the pasted credential without storing anything.
  const encReady = credentialEncryptionReady();
  if (!encReady.ok) {
    return NextResponse.json(
      { error: `Server configuration error: ${encReady.error}` },
      { status: 500 }
    );
  }
  const service = createServiceSupabaseClient();
  if (!service) {
    return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });
  }

  let refreshResult: Awaited<ReturnType<typeof refreshCodexCredential>>;
  try {
    refreshResult = await refreshCodexCredential(refreshToken);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return NextResponse.json(
      {
        error: isTimeout
          ? "OpenAI credential validation timed out. Try again, or run `codex login` and paste a fresh auth.json."
          : "Could not reach OpenAI to validate this Codex credential."
      },
      { status: 504 }
    );
  }

  const { response: refreshResponse, body: refreshBody } = refreshResult;
  const mintedRefreshToken =
    typeof refreshBody.refresh_token === "string" ? refreshBody.refresh_token : "";
  const accessToken = typeof refreshBody.access_token === "string" ? refreshBody.access_token : "";

  if (!refreshResponse.ok || !mintedRefreshToken || !accessToken) {
    // Error responses carry no secrets; log + surface the full detail so a
    // rejection is diagnosable (e.g. burned/rotated token vs account issue).
    let detail = "";
    try {
      const scrubbed = { ...refreshBody };
      delete scrubbed.access_token;
      delete scrubbed.refresh_token;
      detail = JSON.stringify(scrubbed).slice(0, 300);
    } catch {
      detail = "";
    }
    console.error("[codex-paste] refresh validation failed", refreshResponse.status, detail);
    return NextResponse.json(
      {
        error: `OpenAI rejected this Codex credential (status ${refreshResponse.status})${
          detail && detail !== "{}" ? `: ${detail}` : ""
        }. Likely a rotated/expired refresh token — run \`codex login\` again and paste a FRESH auth.json.`
      },
      { status: 400 }
    );
  }

  const accountId = decodeChatGptAccountId(accessToken);
  const encrypted = encryptSecret(mintedRefreshToken);

  const { error } = await service.from("user_llm_credentials").upsert({
    user_id: auth.user.id,
    kind: "codex_oauth",
    ciphertext: bufferToBytea(encrypted.ciphertext),
    iv: bufferToBytea(encrypted.iv),
    auth_tag: bufferToBytea(encrypted.authTag),
    account_id: accountId,
    access_token_expires_at: tokenExpiryIso(Number(refreshBody.expires_in ?? 3600)),
    label: accountId ? `ChatGPT ${accountId}` : "ChatGPT (pasted)",
    status: "active"
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "llm_credential_connect",
    message: "Connected ChatGPT subscription via pasted Codex credential.",
    metadata: { kind: "codex_oauth", method: "paste", account_id: accountId }
  });

  return NextResponse.json({ ok: true, account_id: accountId });
}
