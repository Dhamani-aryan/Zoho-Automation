import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedPlan } from "@/lib/llm/provider";
import { resolveOwner } from "@/lib/constants";

type CrmRecord = {
  id: string;
  zoho_id: string | null;
  zoho_url: string | null;
  name: string;
  owner: string | null;
  raw: Record<string, unknown>;
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

const MODULE_CONFIG = {
  accounts: {
    table: "accounts",
    zohoId: "zoho_account_id",
    name: "account_name",
    metaModule: "Accounts",
    select: "id,zoho_account_id,zoho_url,account_name,owner,website,phone,industry,raw_data"
  },
  contacts: {
    table: "contacts",
    zohoId: "zoho_contact_id",
    name: "full_name",
    metaModule: "Contacts",
    select: "id,zoho_contact_id,zoho_url,full_name,email,title,owner,raw_data"
  },
  deals: {
    table: "deals",
    zohoId: "zoho_deal_id",
    name: "deal_name",
    metaModule: "Deals",
    select: "id,zoho_deal_id,zoho_url,deal_name,stage,next_step,owner,closing_date,amount,raw_data"
  }
} as const;

type ModuleKey = keyof typeof MODULE_CONFIG;

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function fieldToColumn(field: string) {
  return FIELD_COLUMN_MAP[field] ?? field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function isFutureDate(dateStr: string, timeStr?: string) {
  const iso = timeStr ? `${dateStr}T${timeStr}` : dateStr;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null; // unparseable
  return d.getTime() > Date.now();
}

// Allowed picklist values (lowercased) for a module+field, or null if not a picklist.
function buildPicklistIndex(fieldMeta: FieldMetaRow[]) {
  const index = new Map<string, Set<string>>();
  for (const f of fieldMeta) {
    if (!Array.isArray(f.picklist_values) || f.picklist_values.length === 0) continue;
    const values = new Set<string>();
    for (const pv of f.picklist_values as Array<Record<string, unknown>>) {
      const v = pv?.actual_value ?? pv?.display_value ?? pv?.value ?? pv;
      if (typeof v === "string" && v.trim()) values.add(v.trim().toLowerCase());
    }
    if (values.size > 0) index.set(`${f.module}:${f.api_name}`, values);
  }
  return index;
}

function tagsOf(record: CrmRecord): string[] {
  const raw = record.raw;
  const parts: string[] = [];
  for (const key of ["tags", "matched_tags", "all_tags"]) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) parts.push(v);
  }
  return parts
    .flatMap((p) => p.split(/[;,|]/))
    .map((t) => t.trim())
    .filter(Boolean);
}

function rowToRecord(moduleKey: ModuleKey, row: Record<string, unknown>): CrmRecord {
  const config = MODULE_CONFIG[moduleKey];
  const zohoId = row[config.zohoId];
  const name = row[config.name];
  const raw = (row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}) as Record<string, unknown>;

  return {
    id: String(row.id),
    zoho_id: typeof zohoId === "string" ? zohoId : null,
    zoho_url: typeof row.zoho_url === "string" ? row.zoho_url : null,
    name: typeof name === "string" ? name : String(name ?? ""),
    owner: typeof row.owner === "string" ? row.owner : null,
    raw,
    data: row
  };
}

async function fetchModuleRecords(supabase: SupabaseClient, moduleKey: ModuleKey) {
  const config = MODULE_CONFIG[moduleKey];
  const { data, error } = await supabase
    .from(config.table)
    .select(config.select)
    .order(config.name, { ascending: true })
    .limit(2000);
  if (error) throw error;
  return (data ?? []).map((row) => rowToRecord(moduleKey, row as unknown as Record<string, unknown>));
}

type ResolveOutput = {
  records: CrmRecord[];
  warnings: string[];
  unmatched: string[]; // selector values that matched no record
  ambiguous: string[]; // selector values that matched more than one record
};

function resolveRecords(records: CrmRecord[], plan: ParsedPlan): ResolveOutput {
  const selector = plan.record_selector;
  const values = (selector.values ?? []).filter(Boolean);
  const warnings: string[] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];

  if (selector.mode === "tag") {
    const tag = normalize(selector.tag);
    if (!tag) {
      warnings.push("Tag selector had no tag value.");
      return { records: [], warnings, unmatched, ambiguous };
    }
    const matched = records.filter((r) => tagsOf(r).some((t) => normalize(t) === tag || normalize(t).includes(tag)));
    if (matched.length === 0) warnings.push(`No records carry the tag "${selector.tag}".`);
    return { records: matched, warnings, unmatched, ambiguous };
  }

  if (selector.mode === "ids") {
    const out: CrmRecord[] = [];
    for (const value of values) {
      const n = normalize(value);
      const hits = records.filter((r) => normalize(r.id) === n || normalize(r.zoho_id) === n);
      if (hits.length === 0) unmatched.push(value);
      else out.push(...hits);
    }
    return { records: out, warnings, unmatched, ambiguous };
  }

  if (selector.mode === "names" || selector.mode === "file") {
    const out: CrmRecord[] = [];
    for (const value of values) {
      const n = normalize(value);
      // exact by id/zoho id/name first
      let hits = records.filter(
        (r) => normalize(r.name) === n || normalize(r.zoho_id) === n || normalize(r.id) === n
      );
      // fallback: starts_with on name (the proven CRM fallback)
      if (hits.length === 0) hits = records.filter((r) => normalize(r.name).startsWith(n));
      // fallback: contains
      if (hits.length === 0) hits = records.filter((r) => normalize(r.name).includes(n) && n.length >= 3);

      if (hits.length === 0) unmatched.push(value);
      else if (hits.length > 1) ambiguous.push(value);
      else out.push(hits[0]);
    }
    return { records: out, warnings, unmatched, ambiguous };
  }

  // filter mode
  const filter = selector.filter;
  if (!filter) {
    warnings.push("Filter selector was missing filter details.");
    return { records: [], warnings, unmatched, ambiguous };
  }
  const column = fieldToColumn(filter.field);
  const filterValue = normalize(filter.value);
  const matched = records.filter((r) => {
    const rv = normalize(r.data[column] ?? r.raw[column]);
    if (filter.op === "equals") return rv === filterValue;
    if (filter.op === "starts_with") return rv.startsWith(filterValue);
    return rv.includes(filterValue);
  });
  return { records: matched, warnings, unmatched, ambiguous };
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
  const v = ctx.runParameters[key];
  return typeof v === "string" ? v : "";
}

function mapBlock(block: ParsedPlan["blocks"][number], record: CrmRecord, ctx: BlockCtx): Mapped {
  const cfg = block.config ?? {};
  const slug = block.slug;

  // Field updates (deal/account/contact)
  if (slug === "update_deal_field" || slug === "update_account_fields" || slug === "update_contact_fields") {
    const fieldApiName = typeof cfg.field_api_name === "string" ? cfg.field_api_name : null;
    const value = cfg.value;
    if (!fieldApiName) {
      return review(record, "Missing field_api_name for field update.");
    }
    if (value === undefined || value === null || String(value).trim() === "") {
      return review(record, `No new value provided for ${fieldApiName}.`);
    }
    // picklist membership
    const allowed = ctx.picklists.get(`${ctx.metaModule}:${fieldApiName}`);
    if (allowed && !allowed.has(String(value).trim().toLowerCase())) {
      return review(record, `"${value}" is not an allowed option for ${fieldApiName}.`);
    }
    if (fieldApiName === "Email" && !EMAIL_RE.test(String(value))) {
      return review(record, `"${value}" is not a valid email.`);
    }
    const column = fieldToColumn(fieldApiName);
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
    if (!target) return review(record, "No target owner specified.");
    if (!owner) return review(record, `Owner "${target}" is not a known CRM user.`);
    return {
      status: "pending",
      action: `Change owner of ${record.name} to ${owner.name}`,
      before_data: { Owner: record.owner },
      after_data: { Owner: owner.name },
      error_message: null
    };
  }

  if (slug === "add_tags" || slug === "remove_tags") {
    const tags = Array.isArray(cfg.tag_names) ? cfg.tag_names.filter((t) => typeof t === "string") : [];
    if (tags.length === 0) return review(record, "No tag names provided.");
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
    if (!subject) return review(record, "Task subject is required.");
    if (!dueDate) return review(record, "Task due date is required.");
    if (isFutureDate(dueDate) === null) return review(record, `Task due date "${dueDate}" is not a valid date.`);
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
    if (!subject) return review(record, "Task subject to match is required.");
    return {
      status: "pending",
      action: `Complete task matching "${subject}" on ${record.name}`,
      before_data: {},
      after_data: { subject },
      error_message: null
    };
  }

  if (slug === "schedule_email") {
    // Recipient email: prefer the record's own email (contacts), else config.
    const email =
      (typeof record.data.email === "string" && record.data.email) ||
      (typeof cfg.to_email === "string" && cfg.to_email) ||
      "";
    const optOut = record.raw.email_opt_out;
    const subject = typeof cfg.subject === "string" ? cfg.subject : param(ctx, "subject");
    const scheduleDate = typeof cfg.schedule_date === "string" ? cfg.schedule_date : param(ctx, "schedule_date");
    const scheduleTime = typeof cfg.schedule_time === "string" ? cfg.schedule_time : param(ctx, "schedule_time");

    if (!email) return skip(record, "No email address on this record.");
    if (String(optOut).toLowerCase() === "true") return skip(record, "Contact is opted out of email.");
    if (!EMAIL_RE.test(email)) return skip(record, `"${email}" is not a valid email.`);
    if (!subject) return review(record, "Email subject is required.");
    if (!scheduleDate || !scheduleTime) return review(record, "Schedule date and time are required.");
    const future = isFutureDate(scheduleDate, scheduleTime);
    if (future === null) return review(record, `Schedule "${scheduleDate} ${scheduleTime}" is not a valid date/time.`);
    if (future === false) return review(record, `Schedule "${scheduleDate} ${scheduleTime}" is in the past.`);

    return {
      status: "pending",
      action: `Schedule email to ${email} — "${subject}" at ${scheduleDate} ${scheduleTime}`,
      before_data: {},
      after_data: { to_email: email, subject, schedule_date: scheduleDate, schedule_time: scheduleTime },
      error_message: null
    };
  }

  return review(record, `No preview mapper for block "${slug}".`);
}

function review(_record: CrmRecord, message: string): Mapped {
  return { status: "needs_review", action: message, before_data: {}, after_data: {}, error_message: message };
}
function skip(_record: CrmRecord, message: string): Mapped {
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
  const resolved = resolveRecords(moduleRecords, plan);
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

  // Report selector values that could not be resolved so nothing vanishes silently.
  for (const value of resolved.unmatched) {
    items.push(reviewItem(rowNumber++, moduleKey, value, `No ${moduleKey} record matched "${value}".`));
  }
  for (const value of resolved.ambiguous) {
    items.push(reviewItem(rowNumber++, moduleKey, value, `"${value}" matched multiple ${moduleKey} — refine to one.`));
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

  const eligible = items.filter((i) => i.status === "pending").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const needsReview = items.filter((i) => i.status === "needs_review").length;
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
