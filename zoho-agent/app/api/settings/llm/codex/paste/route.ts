import { NextResponse } from "next/server";
import { bufferToBytea } from "@/lib/crypto/bytea";
import { encryptSecret } from "@/lib/crypto/cred";
import { requireApiRole } from "@/lib/auth/guards";
import {
  CODEX_CLIENT_ID,
  OPENAI_TOKEN_ENDPOINT,
  decodeChatGptAccountId,
  tokenExpiryIso
} from "@/lib/llm/codex-oauth";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

// Extract a refresh token from either the pasted ~/.codex/auth.json contents
// or a bare refresh-token string.
function extractRefreshToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try JSON (full auth.json or a fragment).
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const tokens = (parsed.tokens ?? parsed) as Record<string, unknown>;
      const rt = tokens.refresh_token ?? parsed.refresh_token;
      return typeof rt === "string" && rt.trim() ? rt.trim() : null;
    } catch {
      return null;
    }
  }

  // Otherwise treat the whole paste as the refresh token itself.
  return trimmed;
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const raw = typeof body?.credential === "string" ? body.credential : "";
  const refreshToken = extractRefreshToken(raw);
  if (!refreshToken) {
    return NextResponse.json(
      { error: "Paste the contents of your ~/.codex/auth.json (or its refresh_token)." },
      { status: 400 }
    );
  }

  // Validate by performing a real refresh — this also mints the token we store.
  const refreshResponse = await fetch(OPENAI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID
    })
  });
  const refreshBody = await refreshResponse.json().catch(() => ({}));
  if (!refreshResponse.ok || !refreshBody.refresh_token || !refreshBody.access_token) {
    return NextResponse.json(
      { error: refreshBody.error_description ?? "OpenAI rejected this Codex credential. Run `codex login` again and re-copy auth.json." },
      { status: 400 }
    );
  }

  const accountId = decodeChatGptAccountId(refreshBody.access_token);
  const encrypted = encryptSecret(refreshBody.refresh_token);
  const service = createServiceSupabaseClient();
  if (!service) return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });

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
