import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { RunDetailClient, type RunDetail, type RunItem } from "@/components/run-detail-client";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RunDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  if (!supabase) notFound();

  const { data: run } = await supabase
    .from("workflow_runs")
    .select(
      "id,status,run_kind,approval_required,approved_by,approved_at,started_at,completed_at,stop_reason,blocks,run_parameters,totals,created_at,updated_at"
    )
    .eq("id", id)
    .single();

  if (!run) notFound();

  const { data: items } = await supabase
    .from("workflow_run_items")
    .select(
      "id,row_number,record_type,record_key,block_slug,status,action,zoho_url,before_data,after_data,error_message,attempts,claimed_at,executed_at,verified,evidence,created_at,updated_at"
    )
    .eq("workflow_run_id", id)
    .order("row_number", { ascending: true });

  return (
    <AppShell>
      <RunDetailClient initialRun={run as RunDetail} initialItems={(items ?? []) as RunItem[]} />
    </AppShell>
  );
}
