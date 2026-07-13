import { NextResponse } from "next/server";
import { requireExtensionAuth } from "@/lib/extension/auth";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireExtensionAuth(request);
  if ("error" in auth) return auth.error;

  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json({ error: "Supabase Realtime is not configured." }, { status: 500 });
  }

  return NextResponse.json({
    supabase_url: supabaseUrl,
    supabase_anon_key: supabaseAnonKey,
    channel: `tool-jobs:${auth.user.id}`,
    user_id: auth.user.id
  });
}
