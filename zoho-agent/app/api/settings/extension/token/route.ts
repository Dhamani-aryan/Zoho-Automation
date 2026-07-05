import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { hashExtensionToken } from "@/lib/extension/auth";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

function newExtensionToken() {
  return `zext_${randomBytes(32).toString("hex")}`;
}

export async function GET() {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from("user_extension_tokens")
    .select("label,status,created_at,last_seen_at")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    configured: Boolean(data && data.status === "active"),
    token: null,
    label: data?.label ?? null,
    status: data?.status ?? "missing",
    created_at: data?.created_at ?? null,
    last_seen_at: data?.last_seen_at ?? null
  });
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) {
    return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
  const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim() : "Chrome extension";
  const token = newExtensionToken();

  try {
    const { data, error } = await service
      .from("user_extension_tokens")
      .upsert(
        {
          user_id: auth.user.id,
          token_hash: hashExtensionToken(token),
          label,
          status: "active",
          created_at: new Date().toISOString(),
          last_seen_at: null
        },
        { onConflict: "user_id" }
      )
      .select("label,status,created_at,last_seen_at")
      .single();

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "Extension token could not be saved." }, { status: 500 });
    }

    await auth.supabase.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "extension_token_generated",
      message: "Generated a Chrome extension token.",
      metadata: { label }
    });

    return NextResponse.json({
      configured: true,
      token,
      label: data.label,
      status: data.status,
      created_at: data.created_at,
      last_seen_at: data.last_seen_at
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension token generation failed unexpectedly.";
    console.error("[extension-token-generate]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) {
    return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });
  }

  try {
    const { error } = await service
      .from("user_extension_tokens")
      .update({ status: "revoked" })
      .eq("user_id", auth.user.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await auth.supabase.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "extension_token_revoked",
      message: "Revoked the Chrome extension token.",
      metadata: {}
    });

    return NextResponse.json({
      configured: false,
      token: null,
      label: null,
      status: "revoked",
      created_at: null,
      last_seen_at: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension token revoke failed unexpectedly.";
    console.error("[extension-token-revoke]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
