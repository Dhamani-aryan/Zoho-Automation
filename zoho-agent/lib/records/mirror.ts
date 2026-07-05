import type { SupabaseClient } from "@supabase/supabase-js";

export const MIRROR_MODULES = {
  accounts: {
    table: "accounts",
    zohoId: "zoho_account_id",
    name: "account_name",
    metaModule: "Accounts",
    select: "id,zoho_account_id,zoho_url,account_name,owner,website,phone,industry,updated_at,raw_data"
  },
  contacts: {
    table: "contacts",
    zohoId: "zoho_contact_id",
    name: "full_name",
    metaModule: "Contacts",
    select: "id,zoho_contact_id,zoho_url,full_name,email,title,owner,updated_at,raw_data"
  },
  deals: {
    table: "deals",
    zohoId: "zoho_deal_id",
    name: "deal_name",
    metaModule: "Deals",
    select: "id,zoho_deal_id,zoho_url,deal_name,stage,next_step,owner,closing_date,amount,updated_at,raw_data"
  }
} as const;

export type MirrorModuleKey = keyof typeof MIRROR_MODULES;

export type MirrorRecord = {
  id: string;
  zoho_id: string | null;
  zoho_url: string | null;
  name: string;
  owner: string | null;
  raw: Record<string, unknown>;
  data: Record<string, unknown>;
};

export type MirrorRecordSelector = {
  mode: "tag" | "ids" | "names" | "file" | "filter";
  module: MirrorModuleKey;
  tag?: string;
  values?: string[];
  filter?: {
    field: string;
    op: "equals" | "contains" | "starts_with";
    value: string;
  };
};

export type MirrorResolveOutput = {
  records: MirrorRecord[];
  warnings: string[];
  unmatched: string[];
  ambiguous: string[];
  suggestions: Record<string, string[]>;
};

export function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function fieldToColumn(field: string) {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function crmFieldToColumn(field: string) {
  const map: Record<string, string> = {
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
  return map[field] ?? fieldToColumn(field);
}

export function tagsOf(record: MirrorRecord): string[] {
  const parts: string[] = [];
  for (const key of ["tags", "matched_tags", "all_tags", "Tag"]) {
    const value = record.raw[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") parts.push(entry);
        if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
          parts.push((entry as { name: string }).name);
        }
      }
    }
  }
  return parts
    .flatMap((part) => part.split(/[;,|]/))
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function rowToMirrorRecord(moduleKey: MirrorModuleKey, row: Record<string, unknown>): MirrorRecord {
  const config = MIRROR_MODULES[moduleKey];
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

export async function fetchModuleRecords(
  supabase: SupabaseClient,
  moduleKey: MirrorModuleKey,
  limit = 2000
) {
  const query =
    moduleKey === "accounts"
      ? supabase
          .from("accounts")
          .select(MIRROR_MODULES.accounts.select)
          .order(MIRROR_MODULES.accounts.name, { ascending: true })
          .limit(limit)
      : moduleKey === "contacts"
        ? supabase
            .from("contacts")
            .select(MIRROR_MODULES.contacts.select)
            .order(MIRROR_MODULES.contacts.name, { ascending: true })
            .limit(limit)
        : supabase
            .from("deals")
            .select(MIRROR_MODULES.deals.select)
            .order(MIRROR_MODULES.deals.name, { ascending: true })
            .limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => rowToMirrorRecord(moduleKey, row as unknown as Record<string, unknown>));
}

function accountNameOf(record: MirrorRecord): string {
  for (const key of ["Account_Name", "Account Name", "account_name", "ACCOUNTNAME"]) {
    const value = record.raw[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string") {
      return (value as { name: string }).name;
    }
  }
  return "";
}

export function searchTexts(moduleKey: MirrorModuleKey, record: MirrorRecord): string[] {
  const texts = [record.name];
  if (moduleKey === "deals") {
    const account = accountNameOf(record);
    if (account) texts.push(account);
  }
  return texts.map(normalize).filter(Boolean);
}

function tokensOf(value: string) {
  return value.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}

export function tokenMatch(query: string, text: string): boolean {
  const queryTokens = tokensOf(query);
  if (queryTokens.length === 0) return false;
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  return queryTokens.every((queryToken) =>
    words.some((word) => word.startsWith(queryToken) || (word.length >= 3 && queryToken.startsWith(word)))
  );
}

export function anyTokenMatch(query: string, text: string): boolean {
  const queryTokens = tokensOf(query);
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  return queryTokens.some((queryToken) =>
    words.some((word) => word.startsWith(queryToken) || (word.length >= 3 && queryToken.startsWith(word)))
  );
}

export function searchMirrorRecords(
  moduleKey: MirrorModuleKey,
  records: MirrorRecord[],
  query: string,
  limit: number
) {
  const normalized = normalize(query);
  const exact = records.filter((record) =>
    normalize(record.zoho_id) === normalized ||
    normalize(record.id) === normalized ||
    searchTexts(moduleKey, record).some((text) => text === normalized)
  );
  const startsWith = records.filter((record) =>
    searchTexts(moduleKey, record).some((text) => text.startsWith(normalized))
  );
  const contains = normalized.length >= 3
    ? records.filter((record) => searchTexts(moduleKey, record).some((text) => text.includes(normalized)))
    : [];
  const token = records.filter((record) => searchTexts(moduleKey, record).some((text) => tokenMatch(normalized, text)));
  const near = records.filter((record) => searchTexts(moduleKey, record).some((text) => anyTokenMatch(normalized, text)));

  const ranked = [...exact, ...startsWith, ...contains, ...token, ...near];
  const seen = new Set<string>();
  return ranked.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  }).slice(0, limit);
}

export function resolveMirrorRecords(
  records: MirrorRecord[],
  selector: MirrorRecordSelector
): MirrorResolveOutput {
  const moduleKey = selector.module;
  const values = (selector.values ?? []).filter(Boolean);
  const warnings: string[] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const suggestions: Record<string, string[]> = {};

  if (selector.mode === "tag") {
    const tag = normalize(selector.tag);
    if (!tag) {
      warnings.push("Tag selector had no tag value.");
      return { records: [], warnings, unmatched, ambiguous, suggestions };
    }
    const matched = records.filter((record) =>
      tagsOf(record).some((candidate) => normalize(candidate) === tag || normalize(candidate).includes(tag))
    );
    if (matched.length === 0) warnings.push(`No records carry the tag "${selector.tag}".`);
    return { records: matched, warnings, unmatched, ambiguous, suggestions };
  }

  if (selector.mode === "ids") {
    const out: MirrorRecord[] = [];
    for (const value of values) {
      const normalized = normalize(value);
      const hits = records.filter(
        (record) => normalize(record.id) === normalized || normalize(record.zoho_id) === normalized
      );
      if (hits.length === 0) unmatched.push(value);
      else out.push(...hits);
    }
    return { records: out, warnings, unmatched, ambiguous, suggestions };
  }

  if (selector.mode === "names" || selector.mode === "file") {
    const out: MirrorRecord[] = [];
    for (const value of values) {
      const hits = searchMirrorRecords(moduleKey, records, value, records.length);
      if (hits.length === 0) {
        unmatched.push(value);
        const normalized = normalize(value);
        const near = records
          .filter((record) => searchTexts(moduleKey, record).some((text) => anyTokenMatch(normalized, text)))
          .slice(0, 3)
          .map((record) => record.name);
        if (near.length > 0) suggestions[value] = near;
      } else if (hits.length > 1) {
        ambiguous.push(value);
        suggestions[value] = hits.slice(0, 3).map((record) => record.name);
      } else {
        out.push(hits[0]);
      }
    }
    return { records: out, warnings, unmatched, ambiguous, suggestions };
  }

  const filter = selector.filter;
  if (!filter) {
    warnings.push("Filter selector was missing filter details.");
    return { records: [], warnings, unmatched, ambiguous, suggestions };
  }

  const column = crmFieldToColumn(filter.field);
  const filterValue = normalize(filter.value);
  const matched = records.filter((record) => {
    const recordValue = normalize(record.data[column] ?? record.raw[column]);
    if (filter.op === "equals") return recordValue === filterValue;
    if (filter.op === "starts_with") return recordValue.startsWith(filterValue);
    return recordValue.includes(filterValue);
  });
  return { records: matched, warnings, unmatched, ambiguous, suggestions };
}

export function summarizeMirrorRecord(record: MirrorRecord) {
  const data = record.data;
  return {
    id: record.id,
    zoho_id: record.zoho_id,
    zoho_url: record.zoho_url,
    name: record.name,
    owner: record.owner,
    updated_at: typeof data.updated_at === "string" ? data.updated_at : null,
    fields: {
      next_step: data.next_step ?? record.raw.Next_Step ?? null,
      stage: data.stage ?? record.raw.Stage ?? null,
      email: data.email ?? record.raw.Email ?? null,
      title: data.title ?? record.raw.Title ?? null,
      website: data.website ?? record.raw.Website ?? null,
      industry: data.industry ?? record.raw.Industry ?? null
    },
    tags: tagsOf(record)
  };
}
