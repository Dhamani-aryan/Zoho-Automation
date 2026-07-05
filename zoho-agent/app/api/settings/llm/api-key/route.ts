import { NextResponse } from "next/server";
import { bufferToBytea } from "@/lib/crypto/bytea";
import { credentialEncryptionReady, encryptSecret } from "@/lib/crypto/cred";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

function maskApiKey(apiKey: string) {
  return `sk-...${apiKey.slice(-4)}`;
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey.startsWith("sk-")) {
    return NextResponse.json({ error: "Paste a valid OpenAI API key beginning with sk-." }, { status: 400 });
  }

  const encReady = credentialEncryptionReady();
  if (!encReady.ok) {
    return NextResponse.json(
      { error: `Server configuration error: ${encReady.error}` },
      { status: 500 }
    );
  }

  const validation = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!validation.ok) {
    return NextResponse.json({ error: "OpenAI rejected this API key." }, { status: 400 });
  }

  const encrypted = encryptSecret(apiKey);
  const service = createServiceSupabaseClient();
  if (!service) return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });

  const { error } = await service.from("user_llm_credentials").upsert({
    user_id: auth.user.id,
    kind: "openai_api_key",
    ciphertext: bufferToBytea(encrypted.ciphertext),
    iv: bufferToBytea(encrypted.iv),
    auth_tag: bufferToBytea(encrypted.authTag),
    label: maskApiKey(apiKey),
    account_id: null,
    access_token_expires_at: null,
    status: "active"
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "llm_credential_connect",
    message: "Connected OpenAI API key credential.",
    metadata: { kind: "openai_api_key", label: maskApiKey(apiKey) }
  });

  return NextResponse.json({ ok: true, label: maskApiKey(apiKey) });
}
