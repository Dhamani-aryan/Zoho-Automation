#!/usr/bin/env node
/**
 * Loads Zoho field metadata JSON files into Supabase (zoho_field_meta).
 * Expects fields_Accounts.json, fields_Contacts.json, fields_Deals.json, fields_Tasks.json
 * in G:\Zoho Automation\zoho-agent\fieldmeta\ (or pass a directory as argument).
 * Usage: npm run import:fieldmeta
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const dir = process.argv[2] ?? join(projectRoot, "fieldmeta");

for (const line of existsSync(join(projectRoot, ".env.local")) ? readFileSync(join(projectRoot, ".env.local"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

for (const module of ["Accounts", "Contacts", "Deals", "Tasks"]) {
  const p = join(dir, `fields_${module}.json`);
  if (!existsSync(p)) { console.log(`${module}: fields_${module}.json not found in ${dir} — skipped`); continue; }
  const payload = JSON.parse(readFileSync(p, "utf8"));
  const fields = Array.isArray(payload) ? payload : payload.fields ?? payload.data ?? [];
  const rows = fields
    .filter(f => typeof f.api_name === "string" && f.api_name.trim())
    .map(f => ({
      module,
      api_name: f.api_name.trim(),
      label: String(f.field_label ?? f.display_label ?? f.label ?? f.api_name).trim(),
      data_type: typeof f.data_type === "string" ? f.data_type : null,
      picklist_values: f.pick_list_values ?? [],
      raw_data: f,
      synced_at: new Date().toISOString()
    }));
  const { data, error } = await db.from("zoho_field_meta").upsert(rows, { onConflict: "module,api_name" }).select("id");
  if (error) { console.error(`${module}: ERROR ${error.message}`); process.exit(1); }
  console.log(`${module}: ${data.length} fields stored`);
}
console.log("done.");
