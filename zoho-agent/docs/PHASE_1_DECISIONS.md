# Phase 1 Decisions

Confirmed on 2026-07-04.

1. Code lives in `G:\Zoho Automation\zoho-agent\`.
2. Build locally first; Supabase cloud is the database of record from day one.
3. Vercel deploy happens at the end of Phase 1.
4. OpenAI key arrives in Phase 2; scaffold with `OPENAI_API_KEY`.
5. Package manager is npm.
6. UI style is operational: tables, previews, run statuses, no flashy landing page.
7. v1 supports only Zoho org `890324941` on `crm.zoho.com`.
8. Phase 1 field metadata sync is manual JSON paste/admin import.
9. First executor block is `update_deal_field` for Deal `Next_Step`.
10. Link CSVs and sample KD Blitz drafts arrive later.
11. Read-only runs skip approval but still produce logged reports.
12. Owner changes default to no notification email and no cascade.
13. Bulk Stage edits are admin-only in v1.
14. Pre-schedule screenshots are stored for every email record.
15. KD Blitz values are run parameters, not hardcoded.
16. Default CC is `ankur@klouddata.com`, always confirmed in preview.
17. v1 handles existing records only. Zoho record creation is v1.1+.
18. Team onboarding names/roles arrive in Phase 5.
19. Supabase auth uses `@supabase/ssr`; middleware refreshes session cookies and protects pages/API routes.
20. Page/server reads use the user-scoped Supabase client so RLS applies.
21. Service-role Supabase access is limited to bulk record CSV upserts and field metadata upserts after explicit route-level role checks.
22. First admin bootstrap: create the Auth user in Supabase, then insert the matching `public.users` row with role `admin`.
