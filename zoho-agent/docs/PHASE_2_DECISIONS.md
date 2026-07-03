# Phase 2 Decisions

Confirmed on 2026-07-04.

1. Phase 2 stops at parsed, validated, saved previews. It never calls Zoho and never writes CRM data.
2. LLM access is per user. Users connect either a ChatGPT/Codex credential flow or their own OpenAI API key in Settings.
3. LLM secrets are stored in `public.user_llm_credentials` and encrypted with `LLM_CRED_ENC_KEY`.
4. `/api/plan/parse` returns strict plan JSON from the selected provider, then applies server-side guardrails.
5. `/api/plan/validate` resolves records from Supabase under RLS and builds deterministic preview items.
6. Unsupported selectors or unmapped blocks become warnings or `needs_review`; the app does not guess.
7. Saved preview runs use existing `workflow_runs` and `workflow_run_items` tables.
8. A preview with unresolved issues is saved as `draft`; a clean preview is saved as `preview_ready`.
9. Read-only runs keep `approval_required=false`; write runs keep `approval_required=true`.
10. The first deterministic preview mapper is `update_deal_field`, including Deal `Next_Step`.
