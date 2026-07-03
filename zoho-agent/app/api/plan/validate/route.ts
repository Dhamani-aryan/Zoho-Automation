import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { applyPlanGuardrails } from "@/lib/plan/guardrails";
import { validateParsedPlan } from "@/lib/plan/schema";
import { loadPromptCatalog } from "@/lib/plan/system-prompt";
import { validatePlanForPreview } from "@/lib/plan/validation";

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as { plan?: unknown } | null;
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

  const catalog = await loadPromptCatalog();
  const guarded = applyPlanGuardrails({
    plan: parsed.data,
    actionBlocks: catalog.actionBlocks as Array<{ slug: string; admin_only?: boolean }>,
    fieldMeta: catalog.fieldMeta as Array<{ module: string; api_name: string }>,
    role: auth.user.role
  });

  const validation = await validatePlanForPreview({
    supabase: auth.supabase,
    plan: guarded
  });

  await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "plan_validate",
    message: `Validated plan for ${validation.target_count} ${guarded.record_selector.module}.`,
    metadata: {
      status: validation.status,
      target_count: validation.target_count,
      item_count: validation.items.length,
      missing_info_count: validation.missing_info.length
    }
  });

  return NextResponse.json({
    plan: guarded,
    validation
  });
}
