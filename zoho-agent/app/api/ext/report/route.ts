import { NextResponse } from "next/server";
import { requireExtensionAuth } from "@/lib/extension/auth";
import {
  assertItemReportTransition,
  computeStopDecision,
  statusAfterReport,
  type ReportableItemStatus,
  type RunItemStatus,
  type RunStatus
} from "@/lib/orchestrator/state";

type ReportBody = {
  item_id?: unknown;
  status?: unknown;
  before_data?: unknown;
  after_data?: unknown;
  verified?: unknown;
  error_message?: unknown;
  evidence?: unknown;
  stop_run?: unknown;
};

function objectOrEmpty(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function reportStatus(value: unknown): ReportableItemStatus | null {
  return value === "success" || value === "skipped" || value === "failed" ? value : null;
}

function totalsFromItems(items: Array<{ status: RunItemStatus }>) {
  return {
    success: items.filter((item) => item.status === "success").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    failed: items.filter((item) => item.status === "failed").length,
    needs_review: items.filter((item) => item.status === "needs_review").length,
    pending: items.filter((item) => item.status === "pending").length,
    running: items.filter((item) => item.status === "running").length
  };
}

export async function POST(request: Request) {
  const auth = await requireExtensionAuth(request);
  if ("error" in auth) return auth.error;

  try {
    const body = (await request.json().catch(() => null)) as ReportBody | null;
    const itemId = typeof body?.item_id === "string" ? body.item_id : "";
    const status = reportStatus(body?.status);
    if (!itemId || !status) {
      return NextResponse.json({ error: "item_id and status are required." }, { status: 400 });
    }

    const { data: item, error: itemError } = await auth.service
      .from("workflow_run_items")
      .select("id,workflow_run_id,status")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      return NextResponse.json({ error: itemError?.message ?? "Run item not found." }, { status: 404 });
    }

    const { data: run, error: runError } = await auth.service
      .from("workflow_runs")
      .select("id,status,triggered_by")
      .eq("id", item.workflow_run_id)
      .single();

    if (runError || !run) {
      return NextResponse.json({ error: runError?.message ?? "Run not found." }, { status: 404 });
    }

    if (run.triggered_by !== auth.user.id) {
      return NextResponse.json({ error: "This extension cannot report another user's run." }, { status: 403 });
    }

    assertItemReportTransition(item.status as RunItemStatus, status);

    const executedAt = new Date().toISOString();
    const { error: updateError } = await auth.service
      .from("workflow_run_items")
      .update({
        status,
        before_data: objectOrEmpty(body?.before_data),
        after_data: objectOrEmpty(body?.after_data),
        verified: typeof body?.verified === "boolean" ? body.verified : status === "success",
        error_message: typeof body?.error_message === "string" ? body.error_message : null,
        evidence: objectOrEmpty(body?.evidence),
        executed_at: executedAt
      })
      .eq("id", itemId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    const { data: items, error: itemsError } = await auth.service
      .from("workflow_run_items")
      .select("id,status,executed_at")
      .eq("workflow_run_id", run.id)
      .order("executed_at", { ascending: true });

    if (itemsError) {
      return NextResponse.json({ error: itemsError.message }, { status: 500 });
    }

    const allItems = (items ?? []) as Array<{ status: RunItemStatus; executed_at: string | null }>;
    const totals = totalsFromItems(allItems);
    const doneStatuses = allItems
      .filter((done) => done.status === "success" || done.status === "skipped" || done.status === "failed")
      .map((done) => done.status as ReportableItemStatus);
    const stop = computeStopDecision({
      recentDoneStatuses: doneStatuses,
      doneCount: doneStatuses.length,
      failedCount: totals.failed,
      stopRun: body?.stop_run === true,
      stopReason: typeof body?.error_message === "string" ? body.error_message : null
    });
    const nextRunStatus = statusAfterReport({
      currentRunStatus: run.status as RunStatus,
      pendingCount: totals.pending,
      runningCount: totals.running,
      pause: stop.pause
    });

    const runPatch: Record<string, unknown> = {
      status: nextRunStatus,
      totals,
      stop_reason: stop.reason
    };
    if (nextRunStatus === "completed") runPatch.completed_at = executedAt;

    const { error: runUpdateError } = await auth.service.from("workflow_runs").update(runPatch).eq("id", run.id);
    if (runUpdateError) {
      return NextResponse.json({ error: runUpdateError.message }, { status: 500 });
    }

    await auth.service.from("audit_events").insert({
      user_id: auth.user.id,
      workflow_run_id: run.id,
      event_type: "item_executed",
      message: `Extension reported item ${itemId} as ${status}.`,
      metadata: { item_id: itemId, status, verified: body?.verified === true }
    });

    if (nextRunStatus === "paused") {
      await auth.service.from("audit_events").insert({
        user_id: auth.user.id,
        workflow_run_id: run.id,
        event_type: "run_paused",
        message: `Run paused: ${stop.reason}`,
        metadata: { reason: stop.reason }
      });
    }

    if (nextRunStatus === "completed") {
      await auth.service.from("audit_events").insert({
        user_id: auth.user.id,
        workflow_run_id: run.id,
        event_type: "run_completed",
        message: "Run completed.",
        metadata: { totals }
      });
    }

    return NextResponse.json({
      ok: true,
      run_status: nextRunStatus,
      totals,
      stop_reason: stop.reason
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension report failed unexpectedly.";
    console.error("[ext-report]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
