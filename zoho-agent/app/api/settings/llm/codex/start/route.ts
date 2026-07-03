import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_URL,
  CODEX_DEVICE_USER_CODE_ENDPOINT
} from "@/lib/llm/codex-oauth";

export async function POST() {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const response = await fetch(CODEX_DEVICE_USER_CODE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return NextResponse.json({ error: body.error_description ?? "Could not start device-code flow." }, { status: 502 });
  }

  return NextResponse.json({
    device_auth_id: body.device_auth_id,
    user_code: body.user_code,
    interval: body.interval ?? 5,
    verification_uri: CODEX_DEVICE_URL
  });
}
