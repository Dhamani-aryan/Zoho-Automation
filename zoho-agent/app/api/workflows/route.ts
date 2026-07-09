import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";

export async function GET() {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  try {
    const { data, error } = await auth.supabase
      .from("ui_workflows")
      .select("id,name,description,params,steps,effect,trusted,version,created_by,created_at,updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ workflows: data ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflows failed to load.";
    console.error("[workflows-list]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
