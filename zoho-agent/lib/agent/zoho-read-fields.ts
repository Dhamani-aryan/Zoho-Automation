export function normalizeZohoReadFields(fields: string[]) {
  const normalized = [...new Set(fields.map((field) => field.trim()).filter(Boolean))].filter(
    (field) => field.toLowerCase() !== "id"
  );
  if (normalized.length === 0) {
    throw new Error("zoho_get_record requires at least one CRM field besides implicit id.");
  }
  return normalized;
}
