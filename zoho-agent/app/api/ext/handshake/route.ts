import { NextResponse } from "next/server";
import { requireExtensionAuth } from "@/lib/extension/auth";

function emptyCounts() {
  return { pending: 0, running: 0, success: 0, skipped: 0, failed: 0, needs_review: 0 };
}

export async function POST(request: Request) {
  const auth = await requireExtensionAuth(request);
  if ("error" in auth) return auth.error;

  try {
    const { data: runs, error: runsError } = await auth.service
      .from("workflow_runs")
      .select("id,status,blocks,totals,created_at,updated_at")
      .eq("triggered_by", auth.user.id)
      .in("status", ["approved", "running"])
      .order("created_at", { ascending: false })
      .limit(10);

    if (runsError) {
      return NextResponse.json({ error: runsError.message }, { status: 500 });
    }

    const { count: queuedJobs, error: jobsError } = await auth.service
      .from("tool_jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.user.id)
      .eq("status", "queued");

    if (jobsError) {
      return NextResponse.json({ error: jobsError.message }, { status: 500 });
    }

    const runIds = (runs ?? []).map((run) => run.id);
    const counts = new Map<string, ReturnType<typeof emptyCounts>>();

    if (runIds.length > 0) {
      const { data: items, error: itemsError } = await auth.service
        .from("workflow_run_items")
        .select("workflow_run_id,status")
        .in("workflow_run_id", runIds);

      if (itemsError) {
        return NextResponse.json({ error: itemsError.message }, { status: 500 });
      }

      for (const item of items ?? []) {
        const runId = item.workflow_run_id as string;
        const status = item.status as keyof ReturnType<typeof emptyCounts>;
        const count = counts.get(runId) ?? emptyCounts();
        if (status in count) count[status] += 1;
        counts.set(runId, count);
      }
    }

    return NextResponse.json({
      user: { id: auth.user.id, name: auth.user.name, email: auth.user.email },
      queued_jobs: queuedJobs ?? 0,
      approved_runs: (runs ?? []).map((run) => ({
        id: run.id,
        status: run.status,
        blocks: run.blocks,
        item_counts: counts.get(run.id) ?? emptyCounts(),
        totals: run.totals,
        created_at: run.created_at,
        updated_at: run.updated_at
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension handshake failed unexpectedly.";
    console.error("[ext-handshake]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
