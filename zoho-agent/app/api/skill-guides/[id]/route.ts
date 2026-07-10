import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { validateSkillGuideToolCall } from "@/lib/agent/skill-guides";

type PatchBody = {
  name?: unknown;
  intent?: unknown;
  preconditions?: unknown;
  method_api?: unknown;
  method_ui?: unknown;
  gotchas?: unknown;
  verification?: unknown;
  stop_conditions?: unknown;
  params?: unknown;
};

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });

  try {
    const { id } = await params;
    const { data: existing, error: existingError } = await service
      .from("skill_guides")
      .select("id,name,intent,preconditions,method_api,method_ui,gotchas,verification,stop_conditions,params,version")
      .eq("id", id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return NextResponse.json({ error: "Skill guide not found." }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const guide = validateSkillGuideToolCall({
      id: "guide-edit",
      name: "save_skill_guide",
      args: {
        name: typeof body.name === "string" ? body.name : existing.name,
        intent: typeof body.intent === "string" ? body.intent : existing.intent,
        preconditions: typeof body.preconditions === "string" ? body.preconditions : existing.preconditions,
        method_api: typeof body.method_api === "string" ? body.method_api : existing.method_api,
        method_ui: typeof body.method_ui === "string" ? body.method_ui : existing.method_ui,
        gotchas: typeof body.gotchas === "string" ? body.gotchas : existing.gotchas,
        verification: typeof body.verification === "string" ? body.verification : existing.verification,
        stop_conditions: typeof body.stop_conditions === "string" ? body.stop_conditions : existing.stop_conditions,
        params: Array.isArray(body.params) ? body.params : existing.params
      }
    }).args;

    const { data: saved, error } = await service
      .from("skill_guides")
      .update({ ...(guide as Record<string, unknown>), version: Number(existing.version ?? 1) + 1 })
      .eq("id", id)
      .select("id,name,intent,preconditions,method_api,method_ui,gotchas,verification,stop_conditions,params,version,created_at,updated_at")
      .single();
    if (error) throw error;

    await service.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "skill_guide_updated",
      message: `Updated skill guide ${(guide as { name: string }).name}.`,
      metadata: { guide_id: id, name: (guide as { name: string }).name, source: "workflows_page" }
    });

    return NextResponse.json({ guide: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Skill guide update failed unexpectedly.";
    console.error("[skill-guide-update]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
