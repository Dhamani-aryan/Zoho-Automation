// Shared field-validation rule logic for plan preview and any future CRM write
// validation. Picklist membership, email format, and date validity are defined
// once here.

export type FieldMetaRow = {
  module: string;
  api_name: string;
  data_type?: string | null;
  picklist_values?: unknown;
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

// Returns true if the date/time is in the future, false if in the past, and
// null if the string does not parse as a date at all.
export function isFutureDate(dateStr: string, timeStr?: string): boolean | null {
  const iso = timeStr ? `${dateStr}T${timeStr}` : dateStr;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime() > Date.now();
}

// Date validity independent of past/future. Zoho date fields are ISO calendar
// dates (YYYY-MM-DD); datetime fields are ISO 8601. We require the ISO calendar
// shape for date-typed values so "08/31/2026" or "next friday" are rejected
// before an approval card is ever shown.
export function isValidDate(value: string, allowTime = false): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const shape = allowTime
    ? /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?([.]\d+)?([Zz]|[+-]\d{2}:?\d{2})?)?$/
    : /^\d{4}-\d{2}-\d{2}$/;
  if (!shape.test(trimmed)) return false;
  const date = new Date(trimmed);
  return !Number.isNaN(date.getTime());
}

export function buildPicklistIndex(fieldMeta: FieldMetaRow[]): Map<string, Set<string>> {
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

// null  => the field has no picklist constraint (free value allowed)
// true  => value is a member of the picklist
// false => value is NOT a member of the picklist
export function picklistAllows(
  index: Map<string, Set<string>>,
  metaModule: string,
  apiName: string,
  value: unknown
): boolean | null {
  const allowed = index.get(`${metaModule}:${apiName}`);
  if (!allowed) return null;
  return allowed.has(String(value).trim().toLowerCase());
}
