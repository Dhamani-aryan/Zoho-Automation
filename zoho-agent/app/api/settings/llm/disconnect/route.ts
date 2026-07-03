import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export async function POST() {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });

  const { error } = await service
    .from("user_llm_credentials")
    .delete()
    .eq("user_id", auth.user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "llm_credential_disconnect",
    message: "Disconnected OpenAI credential.",
    metadata: {}
  });

  return NextResponse.json({ ok: true });
}
