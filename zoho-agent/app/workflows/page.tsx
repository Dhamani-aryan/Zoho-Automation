import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { WorkflowsManager, type WorkflowRow } from "@/components/workflows-manager";
import { requirePageRole } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const { supabase } = await requirePageRole(["admin", "operator"]);
  const { data, error } = await supabase
    .from("ui_workflows")
    .select("id,name,description,params,steps,effect,trusted,version,created_by,created_at,updated_at")
    .order("updated_at", { ascending: false });

  if (error) throw error;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Agent"
        title="UI workflows"
        description="Manage saved teach-mode workflows. Runs are handed to the agent chat so existing replay gates stay in force."
      />
      <WorkflowsManager initialWorkflows={(data ?? []) as WorkflowRow[]} />
    </AppShell>
  );
}
