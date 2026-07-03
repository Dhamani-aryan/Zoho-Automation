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
