import { ZOHO_CRM_DOMAIN, ZOHO_ORG_ID } from "../constants";
import moduleMap from "./module-map.json";

export const SYNC_MODULES = ["accounts", "contacts", "deals"] as const;
export type SyncModule = (typeof SYNC_MODULES)[number];

type DbError = { message: string };
type DbRow = Record<string, unknown>;
type DbResult<T> = { data: T | null; error: DbError | null };
type Awaitable<T> = PromiseLike<T>;

type SelectBuilder = {
  in(column: string, values: string[]): Awaitable<DbResult<DbRow[]>>;
};

type UpsertBuilder = {
  select(columns: string): Awaitable<DbResult<DbRow[]>>;
};

export type MirrorDbClient = {
  from(table: string): {
    select(columns: string): SelectBuilder;
    upsert(rows: DbRow[], options: { onConflict: string }): UpsertBuilder;
  };
};

type ModuleConfig = {
  table: SyncModule;
  zohoIdColumn: string;
  nameColumn: string;
  urlTab: string;
  compareColumns: string[];
};

const MODULE_CONFIG = moduleMap as Record<SyncModule, ModuleConfig>;

export type SyncRecordSummary = {
  zoho_id: string;
  name: string;
};

export type ZohoUpsertResult = {
  module: SyncModule;
  inserted: SyncRecordSummary[];
  updated: SyncRecordSummary[];
  unchanged_count: number;
  warnings: string[];
};

type BuildContext = {
  accountIds: Map<string, string>;
  contactIds: Map<string, string>;
  warnings: string[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nullableText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function requiredText(value: unknown, label: string, zohoId: string) {
  const text = nullableText(value);
  if (!text) throw new Error(`Zoho record ${zohoId} is missing ${label}.`);
  return text;
}

function lookupId(record: Record<string, unknown>, key: string) {
  const value = asObject(record[key]);
  return typeof value?.id === "string" && value.id.trim() ? value.id.trim() : null;
}

function ownerName(record: Record<string, unknown>) {
  const owner = record.Owner;
  if (typeof owner === "string") return nullableText(owner);
  const object = asObject(owner);
  return nullableText(object?.name);
}

function amount(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function zohoUrl(config: ModuleConfig, zohoId: string) {
  return `https://${ZOHO_CRM_DOMAIN}/crm/org${ZOHO_ORG_ID}/tab/${config.urlTab}/${zohoId}`;
}

function assertRecord(value: unknown): Record<string, unknown> {
  const record = asObject(value);
  if (!record) throw new Error("Each synced Zoho record must be an object.");
  if (typeof record.id !== "string" || !record.id.trim()) {
    throw new Error("Each synced Zoho record must include a string id.");
  }
  return record;
}

function linkedId(
  ctx: BuildContext,
  source: Record<string, unknown>,
  lookupKey: string,
  targetMap: Map<string, string>,
  label: string,
  recordName: string
) {
  const zohoId = lookupId(source, lookupKey);
  if (!zohoId) return null;
  const id = targetMap.get(zohoId);
  if (!id) {
    ctx.warnings.push(`${recordName} references ${label} ${zohoId}, but it is not in the mirror yet.`);
    return null;
  }
  return id;
}

function buildAccountRow(record: Record<string, unknown>) {
  const zohoId = String(record.id).trim();
  const config = MODULE_CONFIG.accounts;
  return {
    zoho_account_id: zohoId,
    zoho_url: zohoUrl(config, zohoId),
    account_name: requiredText(record.Account_Name, "Account_Name", zohoId),
    website: nullableText(record.Website),
    phone: nullableText(record.Phone),
    industry: nullableText(record.Industry),
    owner: ownerName(record),
    source: "zoho_live",
    raw_data: record
  };
}

function buildContactRow(record: Record<string, unknown>, ctx: BuildContext) {
  const zohoId = String(record.id).trim();
  const config = MODULE_CONFIG.contacts;
  const fullName =
    nullableText(record.Full_Name) ??
    [nullableText(record.First_Name), nullableText(record.Last_Name)].filter(Boolean).join(" ").trim();
  const name = requiredText(fullName, "Full_Name", zohoId);
  return {
    zoho_contact_id: zohoId,
    zoho_url: zohoUrl(config, zohoId),
    account_id: linkedId(ctx, record, "Account_Name", ctx.accountIds, "account", name),
    first_name: nullableText(record.First_Name),
    last_name: nullableText(record.Last_Name),
    full_name: name,
    email: nullableText(record.Email),
    title: nullableText(record.Title),
    phone: nullableText(record.Phone),
    mobile: nullableText(record.Mobile),
    owner: ownerName(record),
    source: "zoho_live",
    raw_data: record
  };
}

function buildDealRow(record: Record<string, unknown>, ctx: BuildContext) {
  const zohoId = String(record.id).trim();
  const config = MODULE_CONFIG.deals;
  const name = requiredText(record.Deal_Name, "Deal_Name", zohoId);
  return {
    zoho_deal_id: zohoId,
    zoho_url: zohoUrl(config, zohoId),
    account_id: linkedId(ctx, record, "Account_Name", ctx.accountIds, "account", name),
    primary_contact_id: linkedId(ctx, record, "Contact_Name", ctx.contactIds, "contact", name),
    deal_name: name,
    stage: nullableText(record.Stage),
    next_step: nullableText(record.Next_Step),
    owner: ownerName(record),
    closing_date: dateOnly(record.Closing_Date),
    amount: amount(record.Amount),
    source: "zoho_live",
    raw_data: record
  };
}

function buildRows(module: SyncModule, records: unknown[], ctx: BuildContext) {
  return records.map((value) => {
    const record = assertRecord(value);
    if (module === "accounts") return buildAccountRow(record);
    if (module === "contacts") return buildContactRow(record, ctx);
    return buildDealRow(record, ctx);
  });
}

function collectLookupIds(records: unknown[], key: string) {
  return [
    ...new Set(
      records
        .map((record) => asObject(record))
        .map((record) => (record ? lookupId(record, key) : null))
        .filter((value): value is string => Boolean(value))
    )
  ];
}

async function fetchIdMap(db: MirrorDbClient, table: SyncModule, zohoColumn: string, values: string[]) {
  const map = new Map<string, string>();
  if (values.length === 0) return map;
  const { data, error } = await db.from(table).select(`id,${zohoColumn}`).in(zohoColumn, values);
  if (error) throw new Error(`${table}: ${error.message}`);
  for (const row of data ?? []) {
    const zohoId = row[zohoColumn];
    if (typeof zohoId === "string" && typeof row.id === "string") map.set(zohoId, row.id);
  }
  return map;
}

async function fetchExistingRows(db: MirrorDbClient, config: ModuleConfig, rows: DbRow[]) {
  const ids = rows
    .map((row) => row[config.zohoIdColumn])
    .filter((value): value is string => typeof value === "string" && Boolean(value));
  const { data, error } = await db
    .from(config.table)
    .select([config.zohoIdColumn, ...config.compareColumns].join(","))
    .in(config.zohoIdColumn, ids);
  if (error) throw new Error(`${config.table}: ${error.message}`);
  const map = new Map<string, DbRow>();
  for (const row of data ?? []) {
    const id = row[config.zohoIdColumn];
    if (typeof id === "string") map.set(id, row);
  }
  return map;
}

function stable(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function changed(config: ModuleConfig, existing: DbRow, next: DbRow) {
  return config.compareColumns.some((column) => stable(existing[column]) !== stable(next[column]));
}

function summarize(row: DbRow, config: ModuleConfig): SyncRecordSummary {
  return {
    zoho_id: String(row[config.zohoIdColumn]),
    name: String(row[config.nameColumn])
  };
}

async function upsertChangedRows(db: MirrorDbClient, config: ModuleConfig, rows: DbRow[]) {
  if (rows.length === 0) return;
  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200);
    const { error } = await db
      .from(config.table)
      .upsert(chunk, { onConflict: config.zohoIdColumn })
      .select(`id,${config.zohoIdColumn}`);
    if (error) throw new Error(`${config.table}: ${error.message}`);
  }
}

// Live Zoho API rows are not the same shape as CSV exports, but module/table
// metadata and CSV column mappings are shared through module-map.json.
export async function upsertZohoRecords({
  db,
  module,
  records
}: {
  db: MirrorDbClient;
  module: SyncModule;
  records: unknown[];
}): Promise<ZohoUpsertResult> {
  const config = MODULE_CONFIG[module];
  const warnings: string[] = [];

  // Dedupe by zoho id (keep last occurrence). Paginated zoho_search results
  // can overlap; duplicate keys in one upsert statement make Postgres fail
  // with "ON CONFLICT DO UPDATE command cannot affect row a second time".
  const byId = new Map<string, unknown>();
  for (const value of records) {
    const record = asObject(value);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (id) byId.set(id, value);
    else byId.set(`__invalid_${byId.size}`, value); // keep invalid rows so assertRecord still reports them
  }
  if (byId.size < records.length) {
    warnings.push(`${records.length - byId.size} duplicate record id(s) in the batch were deduplicated.`);
  }
  records = [...byId.values()];

  const accountIds =
    module === "contacts" || module === "deals"
      ? await fetchIdMap(db, "accounts", "zoho_account_id", collectLookupIds(records, "Account_Name"))
      : new Map<string, string>();
  const contactIds =
    module === "deals"
      ? await fetchIdMap(db, "contacts", "zoho_contact_id", collectLookupIds(records, "Contact_Name"))
      : new Map<string, string>();

  const rows = buildRows(module, records, { accountIds, contactIds, warnings }) as DbRow[];
  const existing = await fetchExistingRows(db, config, rows);
  const insertedRows: DbRow[] = [];
  const updatedRows: DbRow[] = [];
  let unchangedCount = 0;

  for (const row of rows) {
    const zohoId = String(row[config.zohoIdColumn]);
    const current = existing.get(zohoId);
    if (!current) insertedRows.push(row);
    else if (changed(config, current, row)) updatedRows.push(row);
    else unchangedCount += 1;
  }

  await upsertChangedRows(db, config, [...insertedRows, ...updatedRows]);

  return {
    module,
    inserted: insertedRows.map((row) => summarize(row, config)),
    updated: updatedRows.map((row) => summarize(row, config)),
    unchanged_count: unchangedCount,
    warnings
  };
}
