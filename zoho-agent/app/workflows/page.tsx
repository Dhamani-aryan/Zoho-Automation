import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { WorkflowsManager, type SkillGuideRow, type WorkflowRow } from "@/components/workflows-manager";
import { requirePageRole } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const { supabase } = await requirePageRole(["admin", "operator"]);
  const { data, error } = await supabase
    .from("ui_workflows")
    .select("id,name,description,params,steps,effect,trusted,version,created_by,created_at,updated_at")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  const { data: guides, error: guidesError } = await supabase
    .from("skill_guides")
    .select("id,name,intent,preconditions,method_api,method_ui,gotchas,verification,stop_conditions,params,version,created_at,updated_at")
    .order("updated_at", { ascending: false });
  if (guidesError) throw guidesError;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Agent"
        title="UI workflows"
        description="Manage saved teach-mode workflows. Runs are handed to the agent chat so existing replay gates stay in force."
      />
      <WorkflowsManager initialWorkflows={(data ?? []) as WorkflowRow[]} initialGuides={(guides ?? []) as SkillGuideRow[]} />
    </AppShell>
  );
}
