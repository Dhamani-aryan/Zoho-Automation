import { NextResponse } from "next/server";
import { bufferToBytea } from "@/lib/crypto/bytea";
import { encryptSecret } from "@/lib/crypto/cred";
import { requireApiRole } from "@/lib/auth/guards";
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_ENDPOINT,
  OPENAI_TOKEN_ENDPOINT,
  decodeChatGptAccountId,
  tokenExpiryIso
} from "@/lib/llm/codex-oauth";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const deviceAuthId = typeof body?.device_auth_id === "string" ? body.device_auth_id : "";
  const userCode = typeof body?.user_code === "string" ? body.user_code : "";
  if (!deviceAuthId || !userCode) {
    return NextResponse.json({ error: "Device auth id and user code are required." }, { status: 400 });
  }

  const codeResponse = await fetch(CODEX_DEVICE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
  });
  const codeBody = await codeResponse.json().catch(() => ({}));

  if (!codeResponse.ok) {
    return NextResponse.json({ error: codeBody.error ?? "Authorization is still pending." }, { status: 400 });
  }

  const tokenResponse = await fetch(OPENAI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: codeBody.authorization_code,
      code_verifier: codeBody.code_verifier,
      client_id: CODEX_CLIENT_ID,
      redirect_uri: CODEX_DEVICE_REDIRECT_URI
    })
  });
  const tokenBody = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok || !tokenBody.refresh_token || !tokenBody.access_token) {
    return NextResponse.json({ error: tokenBody.error_description ?? "Token exchange failed." }, { status: 502 });
  }

  const encrypted = encryptSecret(tokenBody.refresh_token);
  const service = createServiceSupabaseClient();
  if (!service) return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });

  const accountId = decodeChatGptAccountId(tokenBody.access_token);
  const { error } = await service.from("user_llm_credentials").upsert({
    user_id: auth.user.id,
    kind: "codex_oauth",
    ciphertext: bufferToBytea(encrypted.ciphertext),
    iv: bufferToBytea(encrypted.iv),
    auth_tag: bufferToBytea(encrypted.authTag),
    account_id: accountId,
    access_token_expires_at: tokenExpiryIso(Number(tokenBody.expires_in ?? 3600)),
    label: accountId ? `ChatGPT ${accountId}` : "ChatGPT",
    status: "active"
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "llm_credential_connect",
    message: "Connected ChatGPT subscription credential.",
    metadata: { kind: "codex_oauth", account_id: accountId }
  });

  return NextResponse.json({ ok: true, account_id: accountId });
}
