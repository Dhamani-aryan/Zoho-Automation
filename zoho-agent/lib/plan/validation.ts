import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedPlan } from "@/lib/llm/provider";
import { resolveOwner } from "@/lib/constants";
import {
  crmFieldToColumn,
  fetchModuleRecords,
  MIRROR_MODULES,
  resolveMirrorRecords,
  tagsOf,
  type MirrorModuleKey,
  type MirrorRecord
} from "@/lib/records/mirror";

type CrmRecord = MirrorRecord;

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
  eligible_count: number;
  skipped_count: number;
  needs_review_count: number;
  items: PreviewItem[];
  warnings: string[];
  missing_info: string[];
};

export type FieldMetaRow = {
  module: string;
  api_name: string;
  data_type?: string | null;
  picklist_values?: unknown;
};

const MODULE_CONFIG = MIRROR_MODULES;

type ModuleKey = MirrorModuleKey;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isFutureDate(dateStr: string, timeStr?: string) {
  const iso = timeStr ? `${dateStr}T${timeStr}` : dateStr;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime() > Date.now();
}

function buildPicklistIndex(fieldMeta: FieldMetaRow[]) {
  const index = new Map<string, Set<string>>();
  for (const field of fieldMeta) {
    if (!Array.isArray(field.picklist_values) || field.picklist_values.length === 0) continue;
    const values = new Set<string>();
    for (const picklistValue of field.picklist_values as Array<Record<string, unknown>>) {
      const value =
        picklistValue?.actual_value ?? picklistValue?.display_value ?? picklistValue?.value ?? picklistValue;
      if (typeof value === "string" && value.trim()) values.add(value.trim().toLowerCase());
    }
    if (values.size > 0) index.set(`${field.module}:${field.api_name}`, values);
  }
  return index;
}

type BlockCtx = {
  module: ModuleKey;
  metaModule: string;
  picklists: Map<string, Set<string>>;
  runParameters: Record<string, unknown>;
  role: string;
};

type Mapped = {
  status: "pending" | "needs_review" | "skipped";
  action: string;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  error_message: string | null;
};

function param(ctx: BlockCtx, key: string): string {
  const value = ctx.runParameters[key];
  return typeof value === "string" ? value : "";
}

function mapBlock(block: ParsedPlan["blocks"][number], record: CrmRecord, ctx: BlockCtx): Mapped {
  const cfg = block.config ?? {};
  const slug = block.slug;

  if (slug === "update_deal_field" || slug === "update_account_fields" || slug === "update_contact_fields") {
    const fieldApiName = typeof cfg.field_api_name === "string" ? cfg.field_api_name : null;
    const value = cfg.value ?? cfg.new_value;
    if (!fieldApiName) return review("Missing field_api_name for field update.");
    if (value === undefined || value === null || String(value).trim() === "") {
      return review(`No new value provided for ${fieldApiName}.`);
    }

    const allowed = ctx.picklists.get(`${ctx.metaModule}:${fieldApiName}`);
    if (allowed && !allowed.has(String(value).trim().toLowerCase())) {
      return review(`"${value}" is not an allowed option for ${fieldApiName}.`);
    }
    if (fieldApiName === "Email" && !EMAIL_RE.test(String(value))) {
      return review(`"${value}" is not a valid email.`);
    }

    const column = crmFieldToColumn(fieldApiName);
    return {
      status: "pending",
      action: `Set ${fieldApiName} = "${value}" on ${record.name}`,
      before_data: { [fieldApiName]: record.data[column] ?? record.raw[column] ?? null },
      after_data: { [fieldApiName]: value },
      error_message: null
    };
  }

  if (slug === "change_owner") {
    const target = typeof cfg.target_owner === "string" ? cfg.target_owner : param(ctx, "target_owner");
    const owner = target ? resolveOwner(target) : null;
    if (!target) return review("No target owner specified.");
    if (!owner) return review(`Owner "${target}" is not a known CRM user.`);
    return {
      status: "pending",
      action: `Change owner of ${record.name} to ${owner.name}`,
      before_data: { Owner: record.owner },
      after_data: { Owner: owner.name },
      error_message: null
    };
  }

  if (slug === "add_tags" || slug === "remove_tags") {
    const tags = Array.isArray(cfg.tag_names) ? cfg.tag_names.filter((tag) => typeof tag === "string") : [];
    if (tags.length === 0) return review("No tag names provided.");
    return {
      status: "pending",
      action: `${slug === "add_tags" ? "Add" : "Remove"} tags [${tags.join(", ")}] on ${record.name}`,
      before_data: { tags: tagsOf(record) },
      after_data: { [slug === "add_tags" ? "add" : "remove"]: tags },
      error_message: null
    };
  }

  if (slug === "create_task") {
    const subject = typeof cfg.subject === "string" ? cfg.subject : param(ctx, "task_subject");
    const dueDate = typeof cfg.due_date === "string" ? cfg.due_date : param(ctx, "due_date");
    if (!subject) return review("Task subject is required.");
    if (!dueDate) return review("Task due date is required.");
    if (isFutureDate(dueDate) === null) return review(`Task due date "${dueDate}" is not a valid date.`);
    return {
      status: "pending",
      action: `Create task "${subject}" (due ${dueDate}) on ${record.name}`,
      before_data: {},
      after_data: { subject, due_date: dueDate },
      error_message: null
    };
  }

  if (slug === "complete_task") {
    const subject = typeof cfg.subject === "string" ? cfg.subject : param(ctx, "task_subject");
    if (!subject) return review("Task subject to match is required.");
    return {
      status: "pending",
      action: `Complete task matching "${subject}" on ${record.name}`,
      before_data: {},
      after_data: { subject },
      error_message: null
    };
  }

  if (slug === "read_fields") {
    const rawList = Array.isArray(cfg.field_api_names)
      ? cfg.field_api_names
      : cfg.field_api_name != null
        ? [cfg.field_api_name]
        : [];
    const fields = rawList.filter((field): field is string => typeof field === "string" && field.trim() !== "");
    if (fields.length === 0) return review("No fields specified to read.");

    const values: Record<string, unknown> = {};
    for (const field of fields) {
      const column = crmFieldToColumn(field);
      values[field] = record.data[column] ?? record.raw[column] ?? null;
    }
    return {
      status: "pending",
      action: `${fields.map((field) => `${field} = ${JSON.stringify(values[field] ?? null)}`).join(", ")} - read from local copy (as of last import)`,
      before_data: values,
      after_data: {},
      error_message: null
    };
  }

  if (slug === "schedule_email") {
    const email =
      (typeof record.data.email === "string" && record.data.email) ||
      (typeof cfg.to_email === "string" && cfg.to_email) ||
      "";
    const optOut = record.raw.email_opt_out;
    const subject = typeof cfg.subject === "string" ? cfg.subject : param(ctx, "subject");
    const scheduleDate = typeof cfg.schedule_date === "string" ? cfg.schedule_date : param(ctx, "schedule_date");
    const scheduleTime = typeof cfg.schedule_time === "string" ? cfg.schedule_time : param(ctx, "schedule_time");

    if (!email) return skip("No email address on this record.");
    if (String(optOut).toLowerCase() === "true") return skip("Contact is opted out of email.");
    if (!EMAIL_RE.test(email)) return skip(`"${email}" is not a valid email.`);
    if (!subject) return review("Email subject is required.");
    if (!scheduleDate || !scheduleTime) return review("Schedule date and time are required.");

    const future = isFutureDate(scheduleDate, scheduleTime);
    if (future === null) return review(`Schedule "${scheduleDate} ${scheduleTime}" is not a valid date/time.`);
    if (future === false) return review(`Schedule "${scheduleDate} ${scheduleTime}" is in the past.`);

    return {
      status: "pending",
      action: `Schedule email to ${email} - "${subject}" at ${scheduleDate} ${scheduleTime}`,
      before_data: {},
      after_data: { to_email: email, subject, schedule_date: scheduleDate, schedule_time: scheduleTime },
      error_message: null
    };
  }

  return review(`No preview mapper for block "${slug}".`);
}

function review(message: string): Mapped {
  return { status: "needs_review", action: message, before_data: {}, after_data: {}, error_message: message };
}

function skip(message: string): Mapped {
  return { status: "skipped", action: message, before_data: {}, after_data: {}, error_message: message };
}

export async function validatePlanForPreview({
  supabase,
  plan,
  fieldMeta,
  role
}: {
  supabase: SupabaseClient;
  plan: ParsedPlan;
  fieldMeta: FieldMetaRow[];
  role: string;
}): Promise<ValidationResult> {
  const warnings = [...plan.warnings];
  const missingInfo = [...plan.missing_info];
  const moduleKey = plan.record_selector.module as ModuleKey;
  const config = MODULE_CONFIG[moduleKey];

  const moduleRecords = await fetchModuleRecords(supabase, moduleKey);
  const resolved = resolveMirrorRecords(moduleRecords, plan.record_selector);
  warnings.push(...resolved.warnings);

  const ctx: BlockCtx = {
    module: moduleKey,
    metaModule: config.metaModule,
    picklists: buildPicklistIndex(fieldMeta),
    runParameters: plan.run_parameters ?? {},
    role
  };

  const items: PreviewItem[] = [];
  let rowNumber = 1;

  for (const value of resolved.unmatched) {
    const near = resolved.suggestions[value];
    items.push(
      reviewItem(
        rowNumber++,
        moduleKey,
        value,
        `No ${moduleKey} record matched "${value}".${near?.length ? ` Closest: ${near.join("; ")}.` : ""}`
      )
    );
  }

  for (const value of resolved.ambiguous) {
    const options = resolved.suggestions[value];
    items.push(
      reviewItem(
        rowNumber++,
        moduleKey,
        value,
        `"${value}" matched multiple ${moduleKey} - refine to one.${options?.length ? ` Matches: ${options.join("; ")}.` : ""}`
      )
    );
  }

  for (const record of resolved.records) {
    for (const block of plan.blocks) {
      const mapped = mapBlock(block, record, ctx);
      items.push({
        row_number: rowNumber++,
        record_type: moduleKey,
        record_id: record.id,
        record_key: record.zoho_id ?? record.id,
        record_name: record.name,
        zoho_url: record.zoho_url,
        block_slug: block.slug,
        status: mapped.status,
        action: mapped.action,
        before_data: mapped.before_data,
        after_data: mapped.after_data,
        error_message: mapped.error_message
      });
    }
  }

  if (resolved.records.length === 0 && resolved.unmatched.length === 0 && resolved.ambiguous.length === 0) {
    missingInfo.push("No records matched the requested selector.");
  }

  const eligible = items.filter((item) => item.status === "pending").length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  const needsReview = items.filter((item) => item.status === "needs_review").length;
  const status = needsReview > 0 || missingInfo.length > 0 ? "needs_review" : "preview_ready";

  return {
    status,
    target_count: resolved.records.length,
    eligible_count: eligible,
    skipped_count: skipped,
    needs_review_count: needsReview,
    items,
    warnings,
    missing_info: missingInfo
  };
}

function reviewItem(row: number, moduleKey: string, value: string, message: string): PreviewItem {
  return {
    row_number: row,
    record_type: moduleKey,
    record_id: "",
    record_key: value,
    record_name: value,
    zoho_url: null,
    block_slug: "resolve_records",
    status: "needs_review",
    action: message,
    before_data: {},
    after_data: {},
    error_message: message
  };
}
