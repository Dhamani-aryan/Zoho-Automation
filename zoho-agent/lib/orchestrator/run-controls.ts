import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedUser } from "@/lib/auth/guards";

export type ControlRun = {
  id: string;
  status: string;
  run_kind: "read" | "write";
  approval_required: boolean;
  triggered_by: string | null;
  blocks: Array<{ slug?: string; config?: Record<string, unknown> }>;
};

export function canManageRun(run: ControlRun, user: AuthorizedUser) {
  return user.role === "admin" || run.triggered_by === user.id;
}

export async function loadRunForControl(supabase: SupabaseClient, id: string) {
  return supabase
    .from("workflow_runs")
    .select("id,status,run_kind,approval_required,triggered_by,blocks")
    .eq("id", id)
    .single();
}

export async function runHasAdminOnlyBlocks(supabase: SupabaseClient, blocks: ControlRun["blocks"]) {
  const slugs = [...new Set(blocks.map((block) => block.slug).filter((slug): slug is string => Boolean(slug)))];
  if (slugs.length === 0) return false;

  const { count, error } = await supabase
    .from("action_blocks")
    .select("id", { count: "exact", head: true })
    .in("slug", slugs)
    .eq("admin_only", true);

  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function writeRunAudit({
  supabase,
  userId,
  runId,
  eventType,
  message,
  metadata = {}
}: {
  supabase: SupabaseClient;
  userId: string;
  runId: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  await supabase.from("audit_events").insert({
    user_id: userId,
    workflow_run_id: runId,
    event_type: eventType,
    message,
    metadata
  });
}
