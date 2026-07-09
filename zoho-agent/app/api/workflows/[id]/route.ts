import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { prepareUiWorkflow, workflowEffectForSteps, type PreparedUiWorkflow } from "@/lib/agent/ui-tools";

type WorkflowPatchBody = {
  name?: unknown;
  description?: unknown;
  params?: unknown;
  steps?: unknown;
};

type WorkflowDeleteBody = {
  confirm_name?: unknown;
};

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  params: unknown;
  steps: unknown;
  effect: "read" | "write";
  trusted: boolean;
  version: number;
  created_by: string | null;
};

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function loadWorkflow(service: SupabaseClient, id: string) {
  const { data, error } = await service
    .from("ui_workflows")
    .select("id,name,description,params,steps,effect,trusted,version,created_by")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as WorkflowRow | null;
}

function canMutateWorkflow(workflow: WorkflowRow, user: { id: string; role: string }) {
  return user.role === "admin" || workflow.created_by === user.id;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });

  try {
    const { id } = await params;
    const workflow = await loadWorkflow(service, id);
    if (!workflow) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
    if (!canMutateWorkflow(workflow, auth.user)) {
      return NextResponse.json({ error: "You can edit only workflows you created." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as WorkflowPatchBody;
    const nextSteps = Array.isArray(body.steps) ? body.steps : workflow.steps;
    const effect = workflowEffectForSteps(nextSteps as PreparedUiWorkflow["steps"]);
    const prepared = prepareUiWorkflow({
      name: typeof body.name === "string" ? body.name : workflow.name,
      description: typeof body.description === "string" ? body.description : workflow.description ?? "",
      params: Array.isArray(body.params) ? body.params : workflow.params,
      steps: nextSteps,
      effect
    });

    const structureChanged = !sameJson(prepared.steps, workflow.steps) || prepared.effect !== workflow.effect;
    const payload = {
      name: prepared.name,
      description: prepared.description,
      params: prepared.params,
      steps: prepared.steps,
      effect: prepared.effect,
      trusted: structureChanged ? false : workflow.trusted,
      version: structureChanged ? workflow.version + 1 : workflow.version
    };

    const { data: saved, error: updateError } = await service
      .from("ui_workflows")
      .update(payload)
      .eq("id", id)
      .select("id,name,description,params,steps,effect,trusted,version,created_by,created_at,updated_at")
      .single();
    if (updateError) throw updateError;

    await service.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "workflow_updated",
      message: `Updated UI workflow ${prepared.name}.`,
      metadata: {
        workflow_id: id,
        name: prepared.name,
        structure_changed: structureChanged,
        version: payload.version,
        effect: prepared.effect
      }
    });

    return NextResponse.json({ workflow: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow update failed unexpectedly.";
    console.error("[workflow-update]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const service = createServiceSupabaseClient();
  if (!service) return NextResponse.json({ error: "Supabase service role is not configured." }, { status: 500 });

  try {
    const { id } = await params;
    const workflow = await loadWorkflow(service, id);
    if (!workflow) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
    if (!canMutateWorkflow(workflow, auth.user)) {
      return NextResponse.json({ error: "You can delete only workflows you created." }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as WorkflowDeleteBody;
    if (body.confirm_name !== workflow.name) {
      return NextResponse.json({ error: "Type the workflow name exactly to delete it." }, { status: 400 });
    }

    const { error: deleteError } = await service.from("ui_workflows").delete().eq("id", id);
    if (deleteError) throw deleteError;

    await service.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "workflow_deleted",
      message: `Deleted UI workflow ${workflow.name}.`,
      metadata: { workflow_id: id, name: workflow.name, version: workflow.version }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow delete failed unexpectedly.";
    console.error("[workflow-delete]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
