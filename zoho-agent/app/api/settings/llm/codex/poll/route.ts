import { NextResponse } from "next/server";
import { bufferToBytea } from "@/lib/crypto/bytea";
import { credentialEncryptionReady, encryptSecret } from "@/lib/crypto/cred";
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

const OPENAI_TIMEOUT_MS = 15000;
const PENDING_MESSAGE =
  "Approval not confirmed yet. Finish approving in the OpenAI tab, then check again.";

// OpenAI may return `error` as a string OR as an object like { code, message }.
// Always reduce it to a string so the client never renders an object.
function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Compact, token-free snippet of an OpenAI response body for diagnostics.
// Cap length defensively, and scrub in case OpenAI ever returns partial tokens.
function bodySnippet(body: unknown) {
  try {
    const scrubbed = body && typeof body === "object" ? { ...(body as Record<string, unknown>) } : body;
    if (scrubbed && typeof scrubbed === "object") {
      delete (scrubbed as Record<string, unknown>).access_token;
      delete (scrubbed as Record<string, unknown>).refresh_token;
      delete (scrubbed as Record<string, unknown>).id_token;
    }
    const text = JSON.stringify(scrubbed);
    return text && text !== "{}" ? text.slice(0, 300) : "";
  } catch {
    return "";
  }
}

function upstreamFailure(error: unknown, what: string) {
  const isTimeout = error instanceof Error && error.name === "AbortError";
  return NextResponse.json(
    {
      error: isTimeout
        ? `OpenAI did not respond to the ${what} within ${OPENAI_TIMEOUT_MS / 1000}s. Check again in a moment.`
        : `Could not reach OpenAI for the ${what}. Check your connection and try again.`
    },
    { status: 504 }
  );
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const deviceAuthId = typeof body?.device_auth_id === "string" ? body.device_auth_id : "";
  const userCode = typeof body?.user_code === "string" ? body.user_code : "";
  if (!deviceAuthId || !userCode) {
    return NextResponse.json({ error: "Device auth id and user code are required." }, { status: 400 });
  }

  // Fail on server misconfiguration BEFORE consuming the one-time
  // authorization code in the exchange below.
  const encReady = credentialEncryptionReady();
  if (!encReady.ok) {
    return NextResponse.json(
      { error: `Server configuration error: ${encReady.error}` },
      { status: 500 }
    );
  }

  // 1. Poll the device-auth token endpoint (mirrors pi's pollOpenAICodexDeviceAuth).
  let codeResponse: Response;
  try {
    codeResponse = await fetchWithTimeout(CODEX_DEVICE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
    });
  } catch (error) {
    return upstreamFailure(error, "approval check");
  }
  const codeBody = await codeResponse.json().catch(() => ({}));

  if (!codeResponse.ok) {
    const errorCode = extractErrorCode(codeBody);
    // Reference behavior: 403/404 (or an explicit pending/slow_down code) = not approved yet.
    const pending =
      codeResponse.status === 403 ||
      codeResponse.status === 404 ||
      errorCode === "deviceauth_authorization_pending" ||
      errorCode === "slow_down";
    if (!pending) {
      console.error(
        "[codex-poll] device-auth poll failed",
        codeResponse.status,
        bodySnippet(codeBody)
      );
    }
    const detail = bodySnippet(codeBody);
    return NextResponse.json(
      {
        error: pending
          ? PENDING_MESSAGE
          : `OpenAI device authorization failed (status ${codeResponse.status})${
              errorCode ? `: ${errorCode}` : ""
            }${detail ? ` — ${detail}` : ""}`
      },
      { status: pending ? 428 : 502 }
    );
  }

  const authorizationCode =
    typeof codeBody.authorization_code === "string" ? codeBody.authorization_code : "";
  const codeVerifier = typeof codeBody.code_verifier === "string" ? codeBody.code_verifier : "";
  if (!authorizationCode || !codeVerifier) {
    // 200 without the code payload — treat as still pending rather than
    // exchanging literal "undefined" values.
    return NextResponse.json({ error: PENDING_MESSAGE }, { status: 428 });
  }

  // 2. Exchange the authorization code for tokens.
  let tokenResponse: Response;
  try {
    tokenResponse = await fetchWithTimeout(OPENAI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        code_verifier: codeVerifier,
        client_id: CODEX_CLIENT_ID,
        redirect_uri: CODEX_DEVICE_REDIRECT_URI
      })
    });
  } catch (error) {
    return upstreamFailure(error, "token exchange");
  }
  const tokenBody = await tokenResponse.json().catch(() => ({}));

  if (
    !tokenResponse.ok ||
    typeof tokenBody.refresh_token !== "string" ||
    typeof tokenBody.access_token !== "string"
  ) {
    console.error(
      "[codex-poll] token exchange failed",
      tokenResponse.status,
      bodySnippet(tokenBody)
    );
    const summary =
      (typeof tokenBody.error_description === "string" && tokenBody.error_description) ||
      extractErrorCode(tokenBody) ||
      "no error detail returned";
    const detail = bodySnippet(tokenBody);
    return NextResponse.json(
      {
        error: `Token exchange failed (status ${tokenResponse.status}): ${summary}${
          detail ? ` — ${detail}` : ""
        }`
      },
      { status: 502 }
    );
  }

  // 3. Encrypt and store the credential.
  let encrypted: ReturnType<typeof encryptSecret>;
  try {
    encrypted = encryptSecret(tokenBody.refresh_token);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Server configuration error: ${error.message}`
            : "Server configuration error: credential encryption failed."
      },
      { status: 500 }
    );
  }

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
