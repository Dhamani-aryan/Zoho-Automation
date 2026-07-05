import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";

function csvCell(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const { data: run, error: runError } = await auth.supabase
      .from("workflow_runs")
      .select("id,status,run_parameters")
      .eq("id", id)
      .single();

    if (runError || !run) {
      return NextResponse.json({ error: runError?.message ?? "Run not found." }, { status: 404 });
    }

    const { data: items, error: itemError } = await auth.supabase
      .from("workflow_run_items")
      .select("row_number,record_type,record_key,block_slug,status,action,zoho_url,before_data,after_data,verified,error_message,executed_at")
      .eq("workflow_run_id", id)
      .order("row_number", { ascending: true });

    if (itemError) {
      return NextResponse.json({ error: itemError.message }, { status: 500 });
    }

    const header = [
      "row_number",
      "record_type",
      "record_key",
      "block_slug",
      "action",
      "status",
      "verified",
      "zoho_url",
      "before",
      "after",
      "error",
      "executed_at"
    ];
    const rows = (items ?? []).map((item) =>
      [
        item.row_number,
        item.record_type,
        item.record_key,
        item.block_slug,
        item.action,
        item.status,
        item.verified,
        item.zoho_url,
        item.before_data,
        item.after_data,
        item.error_message,
        item.executed_at
      ]
        .map(csvCell)
        .join(",")
    );

    const csv = [header.map(csvCell).join(","), ...rows].join("\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="workflow-run-${run.id}.csv"`
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run CSV export failed unexpectedly.";
    console.error("[run-report-csv]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
