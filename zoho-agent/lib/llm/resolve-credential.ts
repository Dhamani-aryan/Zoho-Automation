import { byteaToBuffer } from "@/lib/crypto/bytea";
import { decryptSecret } from "@/lib/crypto/cred";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export type ResolvedLLMCredential =
  | {
      kind: "missing";
      message: string;
    }
  | {
      kind: "openai_api_key";
      apiKey: string;
      label: string | null;
    }
  | {
      kind: "codex_oauth";
      refreshToken: string;
      accountId: string | null;
      accessTokenExpiresAt: string | null;
      label: string | null;
    };

type CredentialRow = {
  kind: "codex_oauth" | "openai_api_key";
  ciphertext: string | Uint8Array;
  iv: string | Uint8Array;
  auth_tag: string | Uint8Array;
  account_id: string | null;
  access_token_expires_at: string | null;
  label: string | null;
  status: string;
};

export async function resolveCredential(userId: string): Promise<ResolvedLLMCredential> {
  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return { kind: "missing", message: "Supabase service role is not configured." };
  }

  const { data, error } = await supabase
    .from("user_llm_credentials")
    .select("kind,ciphertext,iv,auth_tag,account_id,access_token_expires_at,label,status")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { kind: "missing", message: error.message };
  if (!data) {
    return {
      kind: "missing",
      message: "Connect your OpenAI account in Settings to run commands."
    };
  }

  const row = data as CredentialRow;
  if (row.status !== "active") {
    return {
      kind: "missing",
      message: "Reconnect your OpenAI account in Settings before running commands."
    };
  }

  const secret = decryptSecret({
    ciphertext: byteaToBuffer(row.ciphertext),
    iv: byteaToBuffer(row.iv),
    authTag: byteaToBuffer(row.auth_tag)
  });

  if (row.kind === "openai_api_key") {
    return { kind: "openai_api_key", apiKey: secret, label: row.label };
  }

  return {
    kind: "codex_oauth",
    refreshToken: secret,
    accountId: row.account_id,
    accessTokenExpiresAt: row.access_token_expires_at,
    label: row.label
  };
}
