import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { SkillsLibrary, type SkillGuideRow } from "@/components/skills-library";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const supabase = await createServerSupabaseClient();
  let guides: SkillGuideRow[] = [];
  let loadError: string | null = null;
  let role: UserRole | null = null;

  if (!supabase) {
    loadError = "Supabase is not configured.";
  } else {
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
      role = (profile?.role as UserRole | undefined) ?? null;
    }

    const { data, error } = await supabase
      .from("skill_guides")
      .select(
        "id,name,intent,preconditions,method_api,method_ui,gotchas,verification,stop_conditions,params,version,updated_at,created_at"
      )
      .order("updated_at", { ascending: false });
    if (error) loadError = error.message;
    guides = (data ?? []) as SkillGuideRow[];
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="Agent memory"
        title="Skill guides"
        description="Reusable workflow methods the agent has learned. Core guides are auto-loaded when a request matches their trigger keywords."
      />
      <SkillsLibrary initialGuides={guides} canEdit={role === "admin" || role === "operator"} loadError={loadError} />
    </AppShell>
  );
}


