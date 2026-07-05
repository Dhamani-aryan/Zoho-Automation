import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";

export type ExtensionUser = {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
};

export function hashExtensionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token?.startsWith("zext_")) return null;
  return token;
}

export async function requireExtensionAuth(request: Request) {
  const token = bearerToken(request);
  if (!token) {
    return { error: NextResponse.json({ error: "Extension token required." }, { status: 401 }) };
  }

  const service = createServiceSupabaseClient();
  if (!service) {
    return {
      error: NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 })
    };
  }

  const { data: tokenRow, error: tokenError } = await service
    .from("user_extension_tokens")
    .select("user_id,status")
    .eq("token_hash", hashExtensionToken(token))
    .eq("status", "active")
    .maybeSingle();

  if (tokenError) {
    return { error: NextResponse.json({ error: tokenError.message }, { status: 500 }) };
  }

  if (!tokenRow?.user_id) {
    return { error: NextResponse.json({ error: "Unknown or revoked extension token." }, { status: 401 }) };
  }

  const { data: profile, error: profileError } = await service
    .from("users")
    .select("id,name,email,role,status")
    .eq("id", tokenRow.user_id)
    .single();

  if (profileError || !profile) {
    return {
      error: NextResponse.json({ error: profileError?.message ?? "Extension user is not configured." }, { status: 403 })
    };
  }

  if (profile.status !== "active") {
    return { error: NextResponse.json({ error: "Extension user is not active." }, { status: 403 }) };
  }

  await service
    .from("user_extension_tokens")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("user_id", tokenRow.user_id);

  return {
    service,
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email ?? null,
      role: profile.role as UserRole
    } satisfies ExtensionUser
  };
}
