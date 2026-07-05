import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { assertRunTransition } from "@/lib/orchestrator/state";
import { canManageRun, loadRunForControl, writeRunAudit } from "@/lib/orchestrator/run-controls";
import type { ControlRun } from "@/lib/orchestrator/run-controls";
import type { RunStatus } from "@/lib/orchestrator/state";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const { data: run, error } = await loadRunForControl(auth.supabase, id);
    if (error || !run) {
      return NextResponse.json({ error: error?.message ?? "Run not found." }, { status: 404 });
    }

    const controlRun = run as ControlRun;
    if (!canManageRun(controlRun, auth.user)) {
      return NextResponse.json({ error: "You cannot resume another user's run." }, { status: 403 });
    }

    assertRunTransition(controlRun.status as RunStatus, "running");
    const { data: updated, error: updateError } = await auth.supabase
      .from("workflow_runs")
      .update({ status: "running", stop_reason: null })
      .eq("id", controlRun.id)
      .select("id,status,stop_reason")
      .single();

    if (updateError || !updated) {
      return NextResponse.json({ error: updateError?.message ?? "Run could not be resumed." }, { status: 500 });
    }

    await writeRunAudit({
      supabase: auth.supabase,
      userId: auth.user.id,
      runId: controlRun.id,
      eventType: "run_resumed",
      message: "Resumed workflow run.",
      metadata: {}
    });

    return NextResponse.json({ run: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run resume failed unexpectedly.";
    console.error("[run-resume]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
