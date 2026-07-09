-- V2 Phase F: UI navigation and teachable workflows.
-- Run after supabase/2026_phase_d_writes.sql and the Phase E hardening commit.
-- Additive and idempotent.

alter table public.agent_sessions
  add column if not exists turn_active_until timestamptz;

alter table public.agent_sessions
  add column if not exists teach_mode boolean not null default false;

create index if not exists agent_sessions_turn_active_idx
on public.agent_sessions (turn_active_until)
where turn_active_until is not null;
