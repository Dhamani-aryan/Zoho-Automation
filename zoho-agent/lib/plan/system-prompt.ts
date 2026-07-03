import { createServerSupabaseClient } from "@/lib/supabase/server";

type PromptCatalog = {
  actionBlocks: unknown[];
  presets: unknown[];
  fieldMeta: unknown[];
};

export async function loadPromptCatalog(): Promise<PromptCatalog> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { actionBlocks: [], presets: [], fieldMeta: [] };

  const [blocks, presets, fieldMeta] = await Promise.all([
    supabase
      .from("action_blocks")
      .select("slug,name,module,required_inputs,admin_only,status")
      .eq("status", "active")
      .order("slug"),
    supabase
      .from("presets")
      .select("name,slug,block_chain,status")
      .eq("status", "active")
      .order("name"),
    supabase
      .from("zoho_field_meta")
      .select("module,api_name,label,data_type,picklist_values")
      .order("module")
      .order("api_name")
  ]);

  return {
    actionBlocks: blocks.data ?? [],
    presets: presets.data ?? [],
    fieldMeta: fieldMeta.data ?? []
  };
}

export function buildPlanSystemPrompt(catalog: PromptCatalog) {
  return [
    "You translate a user's Zoho CRM workflow command into strict JSON only.",
    "Do not include prose, markdown, or comments.",
    "Never invent records, IDs, emails, dates, field names, or field values.",
    "If required information is missing, return empty blocks and questions in missing_info.",
    "If the request is vague or maps to no known block, return empty blocks and missing_info.",
    "Only emit block slugs from the action block catalog.",
    "Only emit field api_names from the field metadata catalog.",
    "Use run_kind=read for pure listing/report commands; otherwise use write.",
    "",
    "JSON shape:",
    JSON.stringify({
      intent_summary: "one line summary",
      run_kind: "read | write",
      blocks: [{ slug: "update_deal_field", config: { field_api_name: "Next_Step", value: "2nd Email" } }],
      record_selector: {
        mode: "tag | ids | names | file | filter",
        module: "deals | contacts | accounts",
        tag: "optional",
        values: ["optional"],
        filter: { field: "stage", op: "equals", value: "Follow-Up" }
      },
      run_parameters: {},
      warnings: [],
      missing_info: []
    }),
    "",
    "Action blocks:",
    JSON.stringify(catalog.actionBlocks),
    "",
    "Presets:",
    JSON.stringify(catalog.presets),
    "",
    "Field metadata:",
    JSON.stringify(catalog.fieldMeta)
  ].join("\n");
}
