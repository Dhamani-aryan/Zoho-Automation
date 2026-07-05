-- Seed the read-only `read_fields` action block.
-- Lets read runs answer "what is / show / check <field>" questions from the
-- synced local record copy (no Zoho call, no approval gate).
-- Run in the Supabase SQL Editor. Idempotent.

insert into public.action_blocks
  (slug, name, module, mode, required_inputs, validations, execution_steps, verification, stop_conditions, admin_only, status)
select
  'read_fields',
  'Read record fields',
  'any',
  'helper',
  '["field_api_names"]'::jsonb,
  '["field_api_name valid for module"]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  false,
  'active'
where not exists (
  select 1 from public.action_blocks where slug = 'read_fields'
);
