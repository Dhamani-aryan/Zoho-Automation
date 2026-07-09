-- V2 Phase D: approval-gated Zoho writes.
-- Run after supabase/2026_v2_agent.sql. Additive and idempotent.
--
-- Adds the approval linkage that makes the safety invariant grep-provable:
-- a Tier-2 (write) tool_job may ONLY exist with a non-null approval_id that
-- points at a pending_approvals row the owning user approved. The approvals
-- route is the only writer of these rows; the claim route additionally refuses
-- to hand a Tier-2 job to the extension unless the linked approval is
-- 'approved', and the extension refuses any write job lacking approval_id.

alter table public.tool_jobs
  add column if not exists approval_id uuid references public.pending_approvals(id) on delete set null;

create index if not exists tool_jobs_approval_idx
on public.tool_jobs (approval_id);

-- Fast lookup of the execution job created for an approval (loop resume path).
create index if not exists tool_jobs_session_approval_idx
on public.tool_jobs (session_id, approval_id);

-- pending_approvals is written only by server routes with the service-role key
-- after caller/session/role checks (same pattern as tool_jobs), then read by
-- the owning user through the existing RLS select policy. No client-side insert
-- or update policy is added on purpose.
