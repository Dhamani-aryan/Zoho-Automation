import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ZOHO_CRM_DOMAIN, ZOHO_ORG_ID } from "@/lib/constants";
import { requireExtensionAuth } from "@/lib/extension/auth";
import { MAX_ITEM_ATTEMPTS, CLAIM_STALE_MS, nextItemClaim, statusAfterClaim } from "@/lib/orchestrator/state";
import type { RunStatus, RunItemStatus } from "@/lib/orchestrator/state";

type RunRow = {
  id: string;
  status: RunStatus;
  triggered_by: string;
  blocks: Array<{ slug?: string; config?: Record<string, unknown> }>;
  run_kind: "read" | "write";
  approval_required: boolean;
  run_parameters: Record<string, unknown>;
  totals: Record<string, unknown>;
  started_at: string | null;
};

type ItemRow = {
  id: string;
  row_number: number | null;
  record_type: string | null;
  record_key: string | null;
  block_slug: string | null;
  status: RunItemStatus;
  action: string | null;
  zoho_url: string | null;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  attempts: number;
  claimed_at: string | null;
};

function moduleName(recordType: string | null) {
  if (recordType === "deals") return "Deals";
  if (recordType === "contacts") return "Contacts";
  if (recordType === "accounts") return "Accounts";
  return recordType ?? "";
}

function matchingBlock(run: RunRow, item: ItemRow) {
  return run.blocks.find((block) => block.slug === item.block_slug) ?? null;
}

function itemPayload(run: RunRow, item: ItemRow) {
  const block = matchingBlock(run, item);
  return {
    id: item.id,
    row_number: item.row_number,
    block_slug: item.block_slug,
    record_type: item.record_type,
    module: moduleName(item.record_type),
    zoho_record_id: item.record_key,
    zoho_url: item.zoho_url,
    expected_record_name:
      typeof item.before_data?.record_name === "string" ? item.before_data.record_name : item.action,
    config: {
      ...(block?.config ?? {}),
      before_data: item.before_data,
      after_data: item.after_data
    },
    action: item.action,
    attempts: item.attempts,
    claimed_at: item.claimed_at
  };
}

async function findClaimableItem(service: SupabaseClient, runId: string) {
  const select =
    "id,row_number,record_type,record_key,block_slug,status,action,zoho_url,before_data,after_data,attempts,claimed_at";

  const { data: pending, error: pendingError } = await service
    .from("workflow_run_items")
    .select(select)
    .eq("workflow_run_id", runId)
    .eq("status", "pending")
    .lt("attempts", MAX_ITEM_ATTEMPTS)
    .order("row_number", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (pendingError) throw pendingError;
  if (pending) return pending as ItemRow;

  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: stale, error: staleError } = await service
    .from("workflow_run_items")
    .select(select)
    .eq("workflow_run_id", runId)
    .eq("status", "running")
    .lt("attempts", MAX_ITEM_ATTEMPTS)
    .lt("claimed_at", staleBefore)
    .order("claimed_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (staleError) throw staleError;
  return (stale as ItemRow | null) ?? null;
}

export async function POST(request: Request) {
  const auth = await requireExtensionAuth(request);
  if ("error" in auth) return auth.error;

  try {
    const body = (await request.json().catch(() => null)) as { run_id?: unknown } | null;
    const runId = typeof body?.run_id === "string" ? body.run_id : "";
    if (!runId) {
      return NextResponse.json({ error: "run_id is required." }, { status: 400 });
    }

    const { data: run, error: runError } = await auth.service
      .from("workflow_runs")
      .select("id,status,triggered_by,blocks,run_kind,approval_required,run_parameters,totals,started_at")
      .eq("id", runId)
      .single();

    if (runError || !run) {
      return NextResponse.json({ error: runError?.message ?? "Run not found." }, { status: 404 });
    }

    const runRow = run as RunRow;
    if (runRow.triggered_by !== auth.user.id) {
      return NextResponse.json({ error: "This extension cannot claim another user's run." }, { status: 403 });
    }

    if (runRow.status !== "approved" && runRow.status !== "running") {
      return NextResponse.json({ error: `Run status ${runRow.status} is not claimable.` }, { status: 409 });
    }

    const claimable = await findClaimableItem(auth.service, runRow.id);
    if (!claimable) {
      // Sweep: a running item that exhausted its attempts and went stale can
      // never be reclaimed — without this it strands the run forever.
      const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
      const { error: sweepError } = await auth.service
        .from("workflow_run_items")
        .update({
          status: "failed",
          error_message: "Exceeded max attempts without a report (stale claim).",
          executed_at: new Date().toISOString()
        })
        .eq("workflow_run_id", runRow.id)
        .eq("status", "running")
        .gte("attempts", MAX_ITEM_ATTEMPTS)
        .lt("claimed_at", staleBefore);

      if (sweepError) {
        return NextResponse.json({ error: sweepError.message }, { status: 500 });
      }

      const { count: activeCount, error: activeError } = await auth.service
        .from("workflow_run_items")
        .select("id", { count: "exact", head: true })
        .eq("workflow_run_id", runRow.id)
        .in("status", ["pending", "running"]);

      if (activeError) {
        return NextResponse.json({ error: activeError.message }, { status: 500 });
      }

      const runComplete = (activeCount ?? 0) === 0;
      if (runComplete && runRow.status === "running") {
        // Finalize a run whose last items were swept — no report will arrive
        // to do it. Totals are recomputed from the item statuses.
        const { data: allItems } = await auth.service
          .from("workflow_run_items")
          .select("status")
          .eq("workflow_run_id", runRow.id);
        const rows = (allItems ?? []) as Array<{ status: string }>;
        const countOf = (s: string) => rows.filter((row) => row.status === s).length;
        await auth.service
          .from("workflow_runs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            totals: {
              success: countOf("success"),
              skipped: countOf("skipped"),
              failed: countOf("failed"),
              needs_review: countOf("needs_review"),
              pending: 0,
              running: 0
            }
          })
          .eq("id", runRow.id);
      }

      return NextResponse.json({ item: null, run_complete: runComplete });
    }

    const claim = nextItemClaim({
      status: claimable.status,
      attempts: claimable.attempts,
      claimedAt: claimable.claimed_at
    });

    // Atomic claim: guard on the status+attempts we read so a concurrent
    // poll cannot claim the same item twice. Zero rows updated = lost race.
    const { data: claimed, error: claimError } = await auth.service
      .from("workflow_run_items")
      .update({
        status: claim.status,
        attempts: claim.attempts,
        claimed_at: claim.claimedAt
      })
      .eq("id", claimable.id)
      .eq("status", claimable.status)
      .eq("attempts", claimable.attempts)
      .select(
        "id,row_number,record_type,record_key,block_slug,status,action,zoho_url,before_data,after_data,attempts,claimed_at"
      )
      .maybeSingle();

    if (claimError) {
      return NextResponse.json({ error: claimError.message }, { status: 500 });
    }
    if (!claimed) {
      // Another claimer won the race; caller just polls again.
      return NextResponse.json({ item: null, run_complete: false, lost_race: true });
    }

    const nextRunStatus = statusAfterClaim(runRow.status);
    await auth.service
      .from("workflow_runs")
      .update({
        status: nextRunStatus,
        started_at: runRow.started_at ?? claim.claimedAt
      })
      .eq("id", runRow.id);

    return NextResponse.json({
      item: itemPayload({ ...runRow, status: nextRunStatus }, claimed as ItemRow),
      run_context: {
        id: runRow.id,
        status: nextRunStatus,
        org_id: ZOHO_ORG_ID,
        crm_domain: ZOHO_CRM_DOMAIN,
        run_kind: runRow.run_kind,
        approval_required: runRow.approval_required,
        run_parameters: runRow.run_parameters
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension claim failed unexpectedly.";
    console.error("[ext-claim]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
