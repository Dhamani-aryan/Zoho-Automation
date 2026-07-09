import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const ARCHIVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function DELETE() {
  const auth = await requireApiRole(["admin"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) {
    return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });
  }

  try {
    const cutoff = new Date(Date.now() - ARCHIVED_RETENTION_MS).toISOString();
    const { data, error } = await service
      .from("agent_sessions")
      .delete()
      .eq("status", "archived")
      .lt("updated_at", cutoff)
      .select("id");

    if (error) throw error;

    const purged = data?.length ?? 0;
    await service.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "agent_sessions_purged",
      message: `Purged ${purged} archived agent session(s).`,
      metadata: { purged, cutoff }
    });

    return NextResponse.json({ ok: true, purged, cutoff });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Archived agent session purge failed.";
    console.error("[agent-session-purge]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
