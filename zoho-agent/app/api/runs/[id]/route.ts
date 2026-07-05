import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const { data: run, error: runError } = await auth.supabase
      .from("workflow_runs")
      .select(
        "id,status,run_kind,approval_required,approved_by,approved_at,started_at,completed_at,stop_reason,blocks,run_parameters,totals,created_at,updated_at"
      )
      .eq("id", id)
      .single();

    if (runError || !run) {
      return NextResponse.json({ error: runError?.message ?? "Run not found." }, { status: 404 });
    }

    const { data: items, error: itemError } = await auth.supabase
      .from("workflow_run_items")
      .select(
        "id,row_number,record_type,record_key,block_slug,status,action,zoho_url,before_data,after_data,error_message,attempts,claimed_at,executed_at,verified,evidence,created_at,updated_at"
      )
      .eq("workflow_run_id", id)
      .order("row_number", { ascending: true });

    if (itemError) {
      return NextResponse.json({ error: itemError.message }, { status: 500 });
    }

    return NextResponse.json({
      run,
      items: items ?? []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run detail load failed unexpectedly.";
    console.error("[run-detail]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
