export const ZOHO_ORG_ID = "890324941";
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

// Known Zoho CRM users (owners), from reference/ZOHO_SESSION_API_REFERENCE.md.
// Used to validate change_owner targets before a run. Extend as the team grows.
export const KNOWN_OWNERS: Array<{ name: string; email: string; zoho_user_id: string }> = [
  { name: "Aryan Dhamani", email: "aryan@klouddata.com", zoho_user_id: "6834250000001208001" },
  { name: "Linda Spione", email: "linda.spione@klouddata.com", zoho_user_id: "6834250000003103001" },
  { name: "Ankur Das", email: "ankur@klouddata.com", zoho_user_id: "6834250000000719001" }
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
