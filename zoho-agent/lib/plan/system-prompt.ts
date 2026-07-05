import { createServerSupabaseClient } from "@/lib/supabase/server";

type PromptCatalog = {
  actionBlocks: unknown[];
  presets: unknown[];
  fieldMeta: unknown[];
  tags: Record<string, string[]>;
};

// Tags live as delimited strings in raw_data (tags / matched_tags / all_tags)
// — same keys tagsOf() reads in lib/plan/validation.ts.
function collectTags(rows: Array<Record<string, unknown>> | null): string[] {
  const set = new Set<string>();
  for (const row of rows ?? []) {
    for (const key of ["t1", "t2", "t3"]) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) {
        for (const part of value.split(/[;,|]/)) {
          const tag = part.trim();
          if (tag) set.add(tag);
        }
      }
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

const TAG_SELECT = "t1:raw_data->>tags, t2:raw_data->>matched_tags, t3:raw_data->>all_tags";

export async function loadPromptCatalog(): Promise<PromptCatalog> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { actionBlocks: [], presets: [], fieldMeta: [], tags: {} };

  const [blocks, presets, fieldMeta, accountTags, contactTags, dealTags] = await Promise.all([
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
      .order("api_name"),
    supabase.from("accounts").select(TAG_SELECT).limit(2000),
    supabase.from("contacts").select(TAG_SELECT).limit(2000),
    supabase.from("deals").select(TAG_SELECT).limit(2000)
  ]);

  return {
    actionBlocks: blocks.data ?? [],
    presets: presets.data ?? [],
    fieldMeta: fieldMeta.data ?? [],
    tags: {
      accounts: collectTags(accountTags.data as Array<Record<string, unknown>> | null),
      contacts: collectTags(contactTags.data as Array<Record<string, unknown>> | null),
      deals: collectTags(dealTags.data as Array<Record<string, unknown>> | null)
    }
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
    "Record selector rules:",
    `Known tags by module: ${JSON.stringify(catalog.tags)}`,
    'If the command references one of these tags — or names a campaign/batch that matches one (e.g. "the KD Blitz deals" when "KD Blitz" is a deals tag) — use record_selector.mode="tag" with the exact tag string in record_selector.tag.',
    'Use mode="names" only for actual record names (account/contact/deal names).',
    "",
    "Block config keys (use EXACTLY these keys, no synonyms):",
    "update_deal_field / update_account_fields / update_contact_fields: { field_api_name, value }",
    "change_owner: { target_owner }",
    'add_tags / remove_tags: { tag_names: ["..."] }',
    "create_task: { subject, due_date } (due_date YYYY-MM-DD)",
    "complete_task: { subject }",
    "schedule_email: { subject, schedule_date, schedule_time, to_email? } (date YYYY-MM-DD, time HH:MM; to_email defaults to the contact's own email)",
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
