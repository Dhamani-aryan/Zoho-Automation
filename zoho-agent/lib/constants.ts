export const ZOHO_ORG_ID = "0000000000000000000";
export const ZOHO_CRM_DOMAIN = "crm.zoho.com";

export const RECORD_MODULES = {
  accounts: {
    label: "Accounts",
    table: "accounts",
    idColumn: "zoho_account_id",
    nameColumn: "account_name",
    urlColumn: "zoho_url"
  },
  contacts: {
    label: "Contacts",
    table: "contacts",
    idColumn: "zoho_contact_id",
    nameColumn: "full_name",
    urlColumn: "zoho_url"
  },
  deals: {
    label: "Deals",
    table: "deals",
    idColumn: "zoho_deal_id",
    nameColumn: "deal_name",
    urlColumn: "zoho_url"
  }
} as const;

export type RecordModuleKey = keyof typeof RECORD_MODULES;

// Demo owner directory. Replace this with tenant-specific data in production.
export const KNOWN_OWNERS: Array<{ name: string; email: string; zoho_user_id: string }> = [
  { name: "Demo Admin", email: "admin@example.com", zoho_user_id: "1000000000000000001" },
  { name: "Demo Operator", email: "operator@example.com", zoho_user_id: "1000000000000000002" },
  { name: "Demo Reviewer", email: "reviewer@example.com", zoho_user_id: "1000000000000000003" }
];

export function resolveOwner(input: string) {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;
  return (
    KNOWN_OWNERS.find(
      (o) => o.name.toLowerCase() === needle || o.email.toLowerCase() === needle || o.zoho_user_id === needle
    ) ??
    KNOWN_OWNERS.find((o) => o.name.toLowerCase().includes(needle)) ??
    null
  );
}
