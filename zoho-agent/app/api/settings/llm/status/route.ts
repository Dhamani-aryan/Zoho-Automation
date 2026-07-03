import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";

export async function GET() {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from("user_llm_credentials")
    .select("kind,label,status,account_id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ connected: false });

  return NextResponse.json({ connected: true, ...data });
}
