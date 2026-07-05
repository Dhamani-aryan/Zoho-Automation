import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { getLLMProviderForUser } from "@/lib/llm";
import { parseDelimitedText } from "@/lib/import/csv";
import { extractMarkdownSections } from "@/lib/import/csv";
import { buildPlanSystemPrompt, loadPromptCatalog } from "@/lib/plan/system-prompt";
import { applyPlanGuardrails } from "@/lib/plan/guardrails";
import { validateParsedPlan } from "@/lib/plan/schema";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function summarizeFiles(files: File[]) {
  const summaries: Array<{ name: string; text: string }> = [];

  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      summaries.push({ name: file.name, text: "File omitted from prompt: over 2 MB preview limit." });
      continue;
    }

    const text = await file.text();
    if (file.name.toLowerCase().endsWith(".csv") || file.name.toLowerCase().endsWith(".tsv")) {
      const parsed = parseDelimitedText(text);
      summaries.push({
        name: file.name,
        text: JSON.stringify({
          type: "csv",
          row_count: parsed.rows.length,
          columns: parsed.columns,
          sample_rows: parsed.rows.slice(0, 10)
        })
      });
      continue;
    }

    if (file.name.toLowerCase().endsWith(".md") || file.name.toLowerCase().endsWith(".markdown")) {
      summaries.push({
        name: file.name,
        text: JSON.stringify({
          type: "markdown",
          sections: extractMarkdownSections(text).slice(0, 20),
          sample: text.slice(0, 4000)
        })
      });
      continue;
    }

    summaries.push({ name: file.name, text: text.slice(0, 4000) });
  }

  return summaries;
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const formData = await request.formData();
  const command = String(formData.get("command") ?? "").trim();
  const files = formData.getAll("files").filter((value): value is File => value instanceof File);

  if (!command) {
    return NextResponse.json({ error: "Command is required." }, { status: 400 });
  }

  const started = Date.now();
  let catalog: Awaited<ReturnType<typeof loadPromptCatalog>>;
  let provider: Awaited<ReturnType<typeof getLLMProviderForUser>>;
  let plan: Awaited<ReturnType<typeof provider.parsePlan>>;
  try {
    catalog = await loadPromptCatalog();
    provider = await getLLMProviderForUser(auth.user.id);
    plan = await provider.parsePlan({
      command,
      files: await summarizeFiles(files),
      actionBlockCatalog: catalog.actionBlocks,
      systemPrompt: buildPlanSystemPrompt(catalog)
    });
  } catch (error) {
    // Surface the real reason to the UI — an unhandled throw here would
    // render as a bare "Request failed." with no diagnostic value.
    const message = error instanceof Error ? error.message : "Parse failed unexpectedly.";
    console.error("[plan-parse]", message, error);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const parsed = validateParsedPlan(plan);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "The model returned malformed plan JSON.",
        details: parsed.error.flatten()
      },
      { status: 422 }
    );
  }

  const guarded = applyPlanGuardrails({
    plan: parsed.data,
    actionBlocks: catalog.actionBlocks as Array<{ slug: string; admin_only?: boolean }>,
    fieldMeta: catalog.fieldMeta as Array<{ module: string; api_name: string }>,
    role: auth.user.role
  });

  await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "llm_parse",
    message: `Parsed command with ${provider.name}.`,
    metadata: {
      provider: provider.name,
      latency_ms: Date.now() - started,
      blocks: guarded.blocks.map((block) => block.slug),
      missing_info_count: guarded.missing_info.length
    }
  });

  return NextResponse.json(guarded);
}
