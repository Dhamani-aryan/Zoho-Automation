import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedPlan } from "@/lib/llm/provider";

type CrmRecord = {
  id: string;
  zoho_id: string | null;
  zoho_url: string | null;
  name: string;
  owner: string | null;
  data: Record<string, unknown>;
};

export type PreviewItem = {
  row_number: number;
  record_type: string;
  record_id: string;
  record_key: string;
  record_name: string;
  zoho_url: string | null;
  block_slug: string;
  status: "pending" | "needs_review" | "skipped";
  action: string;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  error_message: string | null;
};

export type ValidationResult = {
  status: "preview_ready" | "needs_review";
  target_count: number;
  items: PreviewItem[];
  warnings: string[];
  missing_info: string[];
};

const MODULE_CONFIG = {
  accounts: {
    table: "accounts",
    zohoId: "zoho_account_id",
    name: "account_name",
    select: "id,zoho_account_id,zoho_url,account_name,owner,website,phone,industry,raw_data"
  },
  contacts: {
    table: "contacts",
    zohoId: "zoho_contact_id",
    name: "full_name",
    select: "id,zoho_contact_id,zoho_url,full_name,email,title,owner,raw_data"
  },
  deals: {
    table: "deals",
    zohoId: "zoho_deal_id",
    name: "deal_name",
    select: "id,zoho_deal_id,zoho_url,deal_name,stage,next_step,owner,closing_date,amount,raw_data"
  }
} as const;

const FIELD_COLUMN_MAP: Record<string, string> = {
  Account_Name: "account_name",
  Amount: "amount",
  Closing_Date: "closing_date",
  Deal_Name: "deal_name",
  Email: "email",
  First_Name: "first_name",
  Last_Name: "last_name",
  Next_Step: "next_step",
  Owner: "owner",
  Phone: "phone",
  Stage: "stage",
  Website: "website"
};

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function fieldToColumn(field: string) {
  return FIELD_COLUMN_MAP[field] ?? field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function rowToRecord(moduleKey: keyof typeof MODULE_CONFIG, row: Record<string, unknown>): CrmRecord {
  const config = MODULE_CONFIG[moduleKey];
  const zohoId = row[config.zohoId];
  const name = row[config.name];

  return {
    id: String(row.id),
    zoho_id: typeof zohoId === "string" ? zohoId : null,
    zoho_url: typeof row.zoho_url === "string" ? row.zoho_url : null,
    name: typeof name === "string" ? name : String(name ?? ""),
    owner: typeof row.owner === "string" ? row.owner : null,
    data: row
  };
}

async function fetchModuleRecords(
  supabase: SupabaseClient,
  moduleKey: keyof typeof MODULE_CONFIG
) {
  const config = MODULE_CONFIG[moduleKey];
  const selectColumns: string = config.select;
  const { data, error } = await supabase
    .from(config.table)
    .select(selectColumns)
    .order(config.name, { ascending: true })
    .limit(1000);

  if (error) throw error;
  return (data ?? []).map((row) => rowToRecord(moduleKey, row as unknown as Record<string, unknown>));
}

function resolveRecords(records: CrmRecord[], plan: ParsedPlan) {
  const selector = plan.record_selector;
  const values = selector.values ?? [];
  const warnings: string[] = [];

  if (selector.mode === "tag") {
    warnings.push("Tag-based record selection is not available until tags are imported.");
    return { records: [] as CrmRecord[], warnings };
  }

  if (selector.mode === "ids") {
    const wanted = new Set(values.map(normalize));
    return {
      records: records.filter((record) => wanted.has(normalize(record.id)) || wanted.has(normalize(record.zoho_id))),
      warnings
    };
  }

  if (selector.mode === "names" || selector.mode === "file") {
    const wanted = new Set(values.map(normalize).filter(Boolean));
    return {
      records: records.filter((record) => wanted.has(normalize(record.name)) || wanted.has(normalize(record.zoho_id))),
      warnings
    };
  }

  const filter = selector.filter;
  if (!filter) {
    warnings.push("Filter selector was missing filter details.");
    return { records: [] as CrmRecord[], warnings };
  }

  const column = fieldToColumn(filter.field);
  const filterValue = normalize(filter.value);
  return {
    records: records.filter((record) => {
      const recordValue = normalize(record.data[column]);
      if (filter.op === "equals") return recordValue === filterValue;
      if (filter.op === "starts_with") return recordValue.startsWith(filterValue);
      return recordValue.includes(filterValue);
    }),
    warnings
  };
}

function buildAction(block: ParsedPlan["blocks"][number], record: CrmRecord) {
  const fieldApiName = typeof block.config.field_api_name === "string" ? block.config.field_api_name : null;
  const value = block.config.value;

  if (block.slug === "update_deal_field" && fieldApiName) {
    const column = fieldToColumn(fieldApiName);
    return {
      action: `Set ${fieldApiName} on ${record.name}`,
      before_data: { [fieldApiName]: record.data[column] ?? null },
      after_data: { [fieldApiName]: value ?? null },
      status: "pending" as const,
      error_message: null
    };
  }

  return {
    action: `Preview ${block.slug} for ${record.name}`,
    before_data: record.data,
    after_data: block.config,
    status: "needs_review" as const,
    error_message: "This action block has no Phase 2 deterministic preview mapper yet."
  };
}

export async function validatePlanForPreview({
  supabase,
  plan
}: {
  supabase: SupabaseClient;
  plan: ParsedPlan;
}): Promise<ValidationResult> {
  const warnings = [...plan.warnings];
  const missingInfo = [...plan.missing_info];
  const moduleRecords = await fetchModuleRecords(supabase, plan.record_selector.module);
  const resolved = resolveRecords(moduleRecords, plan);
  warnings.push(...resolved.warnings);

  if (resolved.records.length === 0) {
    missingInfo.push("No records matched the requested selector.");
  }

  const items: PreviewItem[] = [];
  let rowNumber = 1;

  for (const record of resolved.records) {
    for (const block of plan.blocks) {
      const preview = buildAction(block, record);
      items.push({
        row_number: rowNumber,
        record_type: plan.record_selector.module,
        record_id: record.id,
        record_key: record.zoho_id ?? record.id,
        record_name: record.name,
        zoho_url: record.zoho_url,
        block_slug: block.slug,
        status: preview.status,
        action: preview.action,
        before_data: preview.before_data,
        after_data: preview.after_data,
        error_message: preview.error_message
      });
      rowNumber += 1;
    }
  }

  const needsReview = missingInfo.length > 0 || items.some((item) => item.status !== "pending");
  return {
    status: needsReview ? "needs_review" : "preview_ready",
    target_count: resolved.records.length,
    items,
    warnings,
    missing_info: missingInfo
  };
}
