#!/usr/bin/env python3
"""Clean Zoho export CSVs into import-ready files (conventions: CSV_CLEANING_CONVENTIONS.md).

Usage:
  python clean_exports.py accounts <source.csv> [out.csv]
  python clean_exports.py contacts <source.csv> [out.csv]
  python clean_exports.py deals    <source.csv> [out.csv]

Rules: snake_case headers from Zoho API names, identity columns first,
"Name | email | id" composites split, empty/admin columns dropped, values only trimmed.
"""
import csv, sys

def su(v):
    p = [x.strip() for x in (v or "").split("|")]
    return (p[0] if p else "", p[1] if len(p) > 1 else "", p[2] if len(p) > 2 else "")

def sl(v):
    p = [x.strip() for x in (v or "").split("|")]
    return (p[0] if p and p[0] else "", p[1] if len(p) > 1 else "")

ACCOUNTS = [
    ("zoho_account_id","Record ID"),("zoho_url","Zoho Account Link"),("account_name","Account Name [Account_Name]"),
    ("tags","All Tags"),("matched_tags","Matched Target Tags"),
    ("owner_name",None),("owner_email",None),("owner_id",None),
    ("website","Website [Website]"),("company_linkedin","Company Linkedin [Company_Linkedin]"),("phone","Phone [Phone]"),
    ("industry","Industry [Industry]"),("employees","Employees [Employees]"),("company_size","Company Size [Company_Size]"),
    ("annual_revenue","Annual Revenue [Annual_Revenue]"),("revenue_size","Revenue Size [Revenue_Size]"),
    ("annual_revenue_text","Annual Revenue Text [Annual_Revenue_Text]"),("annual_revenue_numeric","Annual Revenue Numeric [Annual_Revenue_Numeric]"),
    ("parent_account_name",None),("parent_account_id",None),
    ("address","Address [Address]"),("city","City [City]"),("state","State [State]"),("zip","Zip [Zip]"),("country","Country [Country]"),
    ("billing_street","Billing Street [Billing_Street]"),("billing_city","Billing City [Billing_City]"),
    ("billing_state","Billing State [Billing_State]"),("billing_code","Billing Code [Billing_Code]"),("billing_country","Billing Country [Billing_Country]"),
    ("account_code","Account ID [Account_ID]"),("account_status","Account Status [Account_Status]"),
    ("icp_score","ICP Score [ICP_Score]"),("signal_score","Signal Score [Signal_Score]"),("tier","Tier [Tier]"),("track","Track [Track]"),
    ("current_erp_pain","Current ERP Pain [Current_ERP_Pain]"),("budget_sap_roadmap","Budget SAP Roadmap [Budget_SAP_Roadmap]"),("timeline","Timeline [Timeline]"),
    ("trigger_event_news","Trigger Event News [Trigger_Event_News]"),("lead_source","Lead Source [Lead_Source]"),
    ("campaign_name","Campaign Name [Campaign_Name]"),("import_notes","Import Notes [Import_Notes]"),
    ("description","Description [Description]"),
    ("created_by",None),("modified_by",None),
    ("created_time","Created Time [Created_Time]"),("modified_time","Modified Time [Modified_Time]"),("last_activity_time","Last Activity Time [Last_Activity_Time]"),
]

CONTACTS = [
    ("zoho_contact_id","Contact Record ID"),("zoho_url","Zoho Contact Link"),
    ("full_name","Full Name [Full_Name]"),("first_name","First Name [First_Name]"),("last_name","Last Name [Last_Name]"),
    ("email","Email [Email]"),("secondary_email","Secondary Email [Secondary_Email]"),("email_opt_out","Email Opt Out [Email_Opt_Out]"),
    ("title","Title [Title]"),("department","Department [Department]"),("phone","Phone [Phone]"),("mobile","Mobile [Mobile]"),
    ("zoho_account_id","Account Record ID"),("account_zoho_url","Zoho Account Link"),("account_name","Account Name [Account_Name]"),
    ("account_tags","Associated Account Target Tags"),("tags","All Contact Tags"),
    ("deal_ids","Deal Record ID(s)"),("deal_urls","Zoho Deal Link(s)"),("deal_names","Associated Deal Name(s)"),
    ("owner_name",None),("owner_email",None),("owner_id",None),
    ("lead_source","Lead Source [Lead_Source]"),
    ("employee_linkedin","Employee Linkedin [Employee_Linkedin]"),("prospect_linkedin","Prospect LinkedIn [Prospect_LinkedIn]"),("twitter","Twitter [Twitter]"),
    ("mailing_street","Mailing Street [Mailing_Street]"),("mailing_city","Mailing City [Mailing_City]"),
    ("mailing_state","Mailing State [Mailing_State]"),("mailing_zip","Mailing Zip [Mailing_Zip]"),("mailing_country","Mailing Country [Mailing_Country]"),
    ("company_address","Company Address [Company_Address]"),("company_city","Company City [Company_City]"),
    ("company_state","Company State [Company_State]"),("company_zip","Company Zip [Company_Zip]"),("company_country","Company Country [Company_Country]"),
    ("company_size","Company Size [Company_Size]"),("company_revenue_size","Company Revenue Size [Company_Revenue_Size]"),
    ("company_industry","Company Industry [Company_Industry]"),("company_linkedin","Company Linkedin [Company_Linkedin]"),
    ("description","Description [Description]"),
    ("created_by",None),("modified_by",None),
    ("created_time","Created Time [Created_Time]"),("modified_time","Modified Time [Modified_Time]"),("last_activity_time","Last Activity Time [Last_Activity_Time]"),
]

DEALS = [
    ("zoho_deal_id","Deal Record ID"),("zoho_url","Zoho Deal Link"),("deal_name","Deal Name [Deal_Name]"),
    ("zoho_account_id","Account Record ID"),("account_zoho_url","Zoho Account Link"),("account_name","Account Name [Account_Name]"),
    ("primary_contact_name",None),("primary_contact_id",None),
    ("tags","All Deal Tags"),("owner_name",None),("owner_email",None),("owner_id",None),
    ("stage","Stage [Stage]"),("next_step","Next Step [Next_Step]"),("probability","Probability (%) [Probability]"),
    ("type","Type [Type]"),("amount","Amount [Amount]"),("closing_date","Closing Date [Closing_Date]"),
    ("lead_source","Lead Source [Lead_Source]"),("campaign_source","Campaign Source [Campaign_Source]"),
    ("description","Description [Description]"),
    ("created_by",None),("modified_by",None),
    ("created_time","Created Time [Created_Time]"),("modified_time","Modified Time [Modified_Time]"),("last_activity_time","Last Activity Time [Last_Activity_Time]"),
]

OWNER_COL = {"accounts":"Account Owner [Owner]","contacts":"Contact Owner [Owner]","deals":"Deal Owner [Owner]"}
MAPPING = {"accounts":ACCOUNTS,"contacts":CONTACTS,"deals":DEALS}
DEFAULT_OUT = {"accounts":"master_accounts_clean.csv","contacts":"master_contacts_clean.csv","deals":"master_deals_clean.csv"}

def clean(kind, src, dest):
    M = MAPPING[kind]
    rows = list(csv.DictReader(open(src, newline="", encoding="utf-8-sig")))
    out = []
    for r in rows:
        o = {}
        for new, s in M:
            if s:
                o[new] = (r.get(s) or "").strip()
        o["owner_name"], o["owner_email"], o["owner_id"] = su(r[OWNER_COL[kind]])
        o["created_by"] = su(r["Created By [Created_By]"])[0]
        o["modified_by"] = su(r["Modified By [Modified_By]"])[0]
        if kind == "accounts":
            o["parent_account_name"], o["parent_account_id"] = sl(r.get("Parent Account [Parent_Account]", ""))
        if kind == "deals":
            o["primary_contact_name"], o["primary_contact_id"] = sl(r.get("Contact Name [Contact_Name]", ""))
        out.append(o)
    fields = [m[0] for m in M]
    with open(dest, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader(); w.writerows(out)
    # basic integrity
    idcol = fields[0]
    ids = [o[idcol] for o in out]
    print(f"{kind}: {len(out)} rows -> {dest} | dup ids: {len(ids)-len(set(ids))}")

if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in MAPPING:
        print(__doc__); sys.exit(1)
    kind, src = sys.argv[1], sys.argv[2]
    dest = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_OUT[kind]
    clean(kind, src, dest)
