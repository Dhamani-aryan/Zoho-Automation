import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { validateParsedPlan } from "@/lib/plan/schema";
import { loadPromptCatalog } from "@/lib/plan/system-prompt";
import { validatePlanForPreview } from "@/lib/plan/validation";
import type { PreviewItem, ValidationResult } from "@/lib/plan/validation";

function computeTotals(items: PreviewItem[]) {
  return {
    success: 0,
    skipped: items.filter((item) => item.status === "skipped").length,
    failed: 0,
    needs_review: items.filter((item) => item.status === "needs_review").length,
    pending: items.filter((item) => item.status === "pending").length
  };
}

export async function GET() {
  const auth = await requireApiRole(["admin", "operator", "reviewer"]);
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from("workflow_runs")
    .select("id,status,run_kind,approval_required,triggered_by,run_parameters,totals,created_at,updated_at")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ runs: data ?? [] });
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as {
    plan?: unknown;
    validation?: ValidationResult;
  } | null;

  const parsed = validateParsedPlan(body?.plan);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "A valid parsed plan is required.",
        details: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  let validation = body?.validation;
  if (!validation) {
    const catalog = await loadPromptCatalog();
    validation = await validatePlanForPreview({
      supabase: auth.supabase,
      plan: parsed.data,
      fieldMeta: catalog.fieldMeta as Array<{
        module: string;
        api_name: string;
        data_type?: string | null;
        picklist_values?: unknown;
      }>,
      role: auth.user.role
    });
  }
  const runStatus = validation.status === "preview_ready" ? "preview_ready" : "draft";
  const totals = computeTotals(validation.items);

  const { data: run, error: runError } = await auth.supabase
    .from("workflow_runs")
    .insert({
      blocks: parsed.data.blocks,
      run_kind: parsed.data.run_kind,
      approval_required: parsed.data.run_kind === "write",
      triggered_by: auth.user.id,
      status: runStatus,
      run_parameters: {
        ...parsed.data.run_parameters,
        intent_summary: parsed.data.intent_summary,
        record_selector: parsed.data.record_selector,
        warnings: validation.warnings,
        missing_info: validation.missing_info
      },
      totals
    })
    .select("id,status,run_kind,approval_required,run_parameters,totals,created_at")
    .single();

  if (runError || !run) {
    return NextResponse.json({ error: runError?.message ?? "Run could not be created." }, { status: 500 });
  }

  if (validation.items.length > 0) {
    const { error: itemError } = await auth.supabase.from("workflow_run_items").insert(
      validation.items.map((item) => ({
        workflow_run_id: run.id,
        row_number: item.row_number,
        record_type: item.record_type,
        record_key: item.record_key,
        block_slug: item.block_slug,
        status: item.status,
        action: item.action,
        zoho_url: item.zoho_url,
        before_data: {
          ...item.before_data,
          record_id: item.record_id,
          record_name: item.record_name
        },
        after_data: item.after_data,
        error_message: item.error_message
      }))
    );

    if (itemError) {
      await auth.supabase.from("workflow_runs").update({ status: "failed" }).eq("id", run.id);
      return NextResponse.json({ error: itemError.message }, { status: 500 });
    }
  }

  await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    workflow_run_id: run.id,
    event_type: "run_preview_created",
    message: `Created preview run with ${validation.items.length} item(s).`,
    metadata: {
      status: runStatus,
      totals,
      target_count: validation.target_count
    }
  });

  return NextResponse.json({ run, validation }, { status: 201 });
}
