# CSV Cleaning Conventions (template: master_tagged_accounts.csv → master_accounts_clean.csv)

Rules applied to all incoming Zoho export CSVs before import. Cleaned on 2026-07-04; source kept in `source_docs`/uploads, cleaned output in `imports\`.

**Reusable script:** `clean_exports.py` in this folder — `python clean_exports.py accounts|contacts|deals <source.csv> [out.csv]` reapplies these rules to refreshed exports.

**UPDATE 2026-07-04 (v2 exports):** Aryan re-exported with the 4 previously missing accounts. Current clean set: **315 accounts, 833 contacts, 179 deals**. All cross-checks green: every deal and contact links to a known account; every contact deal-reference exists in deals. Remaining known gaps: deal "Ui Acquisition Holding Co. | SAP Cloud ERP" has no contact anywhere; 17 contacts have no email (auto-skip for email workflows).

## Rules

1. **Headers → snake_case** based on the Zoho API name in brackets (`Account Name [Account_Name]` → `account_name`).
2. **Composite user fields split**: `Name | email | id` → `owner_name`, `owner_email`, `owner_id`. Created/Modified By keep name only.
3. **Lookup fields split**: `Name | id` → `parent_account_name`, `parent_account_id`.
4. **Identity first**: `zoho_account_id` (from Record ID), `zoho_url` (from record link) are the first columns and the dedup keys.
5. **Drop columns that are 100% empty** across all rows.
6. **Drop admin noise**: Layout, Locked (all false), Account Number (all 0), Change Log Time, Enrich Status, Record Image, Territories.
7. **No value mutation** beyond trimming whitespace — dates, revenue text, tags stay as exported.
8. Structural validation before accepting: duplicate IDs, missing names, URL↔ID mismatches (all zero in this file).

## Accounts file: kept columns (49)

zoho_account_id, zoho_url, account_name, tags, matched_tags, owner_name, owner_email, owner_id, website, company_linkedin, phone, industry, employees, company_size, annual_revenue, revenue_size, annual_revenue_text, annual_revenue_numeric, parent_account_name, parent_account_id, address, city, state, zip, country, billing_street, billing_city, billing_state, billing_code, billing_country, account_code (was custom "Account ID", e.g. ACC-024), account_status, icp_score, signal_score, tier, track, current_erp_pain, budget_sap_roadmap, timeline, trigger_event_news, lead_source, campaign_name, import_notes, description, created_by, modified_by, created_time, modified_time, last_activity_time

## Dropped columns (18)

Empty: Rating, Account Site, Ticker Symbol, Account Type, Ownership, SIC Code, all Shipping_* (5), Record Image, Territories, Change Log Time, Last Enriched Time, Enrich Status, Connected To.
Noise: Account Number (all "0"), Layout, Locked, Fax (single value `(650) 802-0401` on one record — recoverable from the source file).

## master_accounts_clean.csv facts

311 accounts, 0 duplicate IDs, 0 missing names, all URLs valid for org 890324941.
Owners: Aryan Dhamani 203, Linda Spione 78, Ankur Das 30.
Tag batches: KD Blitz 117, Unbound 100 98, Old List 86, GMT Fabric/FOCUS 9, US-200-IndustryPulse 1.
Campaign-scored subset (ICP/tier/track/ERP-pain fields): 28 accounts.

## Deals file: master_all_deals.csv → master_deals_clean.csv (2026-07-04)

33 → 26 columns, same rules. Kept: zoho_deal_id, zoho_url, deal_name, zoho_account_id, account_zoho_url, account_name, primary_contact_name, primary_contact_id, tags, owner_name/email/id, stage, next_step, probability, type, amount, closing_date, lead_source, campaign_source, description, created_by, modified_by, created/modified/last_activity times.
Dropped — empty: Lead Conversion Time, Territory, Change Log Time, Reason For Loss, Connected To, Stage Modified Time. Noise: Locked (all false), Sales Cycle Duration, Overall Sales Duration, Expected Revenue (derived, 1 value).

**Facts:** 179 deals, 0 dup IDs, all deal+account URL/ID pairs consistent, exactly 1 deal per account. Stages: Follow-Up 101, MQL Lead 70, Nurture 7, Opportunity 1. Owners: Linda 100, Aryan 67, Ankur 12. Contact linked on 163; 16 deals have no primary contact — **this is normal** (confirmed by Aryan): the deal's Contact_Name lookup is optional. Contact targeting for workflows comes from contacts linked via the account (and batch files), not from this single lookup field.

**Flags for review:**
1. 4 deals reference accounts missing from the accounts master: Ardelyx, Duraco Specialty Tapes and Liners, NN Inc., Varex Imaging (IDs 6834250000002759114/121/024/045).
2. Deal "Mini-Circuits I SAP Cloud ERP" uses letter "I" instead of "|" in its name (left as-is; fix in Zoho later).
3. next_step is free text with 18 variants (incl. composites like "3rd Email | Second Email New Contact" and one-offs like "Call Scheduled for 25th May") — validation must treat it as text, not a picklist.

## Contacts file: master_tagged_account_contacts.csv → master_contacts_clean.csv (2026-07-04)

81 → 47 columns, same rules. Multi-value deal linkage kept as-is: `deal_ids`, `deal_urls`, `deal_names` (no contact in this export has more than one deal). `email_opt_out` kept deliberately (compliance gate for email scheduling; currently all false).
Dropped — empty (30+): Date of Birth, Assistant, visitor/Marketo tracking block, Other_* address block, Reporting To, Unsubscribed fields, enrich/admin fields. Noise/near-empty: Layout, Locked, Salutation (7), Home Phone (2), Other Phone (3), Fax (4) — recoverable from source.

**Facts:** 805 contacts, 0 dup IDs, 0 dup emails, all URL/ID pairs consistent, every contact's account exists in accounts master, every referenced deal exists in deals master, full_name always = first+last, opt-out all false. Owners: Linda 333, Aryan 245, Ankur 227.

**Coverage gaps (expected shape of the data, flagged for awareness):**
1. 16 contacts have no email → auto-skipped by email workflows (Tom Wierimaa/1888 Mills, Abdel-Wahhab Khalil/Christie Digital, Patrick Waddick/Cirrus, Dustin Hullinger/Custom-Pak, Michael L./Elliott Equipment, Robert Richards/Floworks, +10).
2. 112 contacts have no deal link; 53 of 311 accounts have no contact in this file.
3. 5 deals have no contact anywhere: Ardelyx, Duraco, NN Inc., Varex Imaging (the 4 whose accounts are also missing from the accounts master) + Ui Acquisition Holding Co.

## Import mapping (app Imports screen → accounts table)

zoho_account_id → zoho_account_id · zoho_url → zoho_url · account_name → account_name · website → website · phone → phone · industry → industry · owner_name → owner. Everything else lands in `raw_data` automatically.
