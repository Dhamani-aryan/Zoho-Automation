#!/usr/bin/env node
/**
 * Initial data load: imports the three cleaned master CSVs into Supabase.
 * Usage: npm run import:masters  (or: node scripts/import-masters.mjs [importsDir])
 * Idempotent: upserts on zoho_*_id, safe to re-run after export refreshes.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const importsDir = process.argv[2] ?? resolve(projectRoot, "..", "imports");
const moduleMap = JSON.parse(readFileSync(join(projectRoot, "lib", "records", "module-map.json"), "utf8"));

// --- env ---------------------------------------------------------------
function loadEnvLocal() {
  const p = join(projectRoot, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)");
  process.exit(1);
}
const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// --- tiny CSV parser (quotes, embedded newlines) -----------------------
function parseCsv(text) {
  const rows = [];
  let row = [], val = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"') { if (q && n === '"') { val += '"'; i++; } else q = !q; continue; }
    if (c === "," && !q) { row.push(val); val = ""; continue; }
    if ((c === "\n" || c === "\r") && !q) {
      if (c === "\r" && n === "\n") i++;
      row.push(val); if (row.some(x => x.trim() !== "")) rows.push(row);
      row = []; val = ""; continue;
    }
    val += c;
  }
  row.push(val); if (row.some(x => x.trim() !== "")) rows.push(row);
  const header = rows[0];
  return rows.slice(1).map(cells => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()])));
}
const load = f => parseCsv(readFileSync(join(importsDir, f), "utf8").replace(/^﻿/, ""));
const nn = v => (v && v.trim() ? v.trim() : null);
const num = v => { const x = Number((v ?? "").replace(/[$,]/g, "")); return v && Number.isFinite(x) ? x : null; };

// --- upsert in chunks, return zoho_id -> uuid map ----------------------
async function upsert(table, rows, conflict, zohoCol) {
  const map = new Map();
  let stored = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error } = await db.from(table).upsert(chunk, { onConflict: conflict }).select(`id,${zohoCol}`);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const d of data) map.set(d[zohoCol], d.id);
    stored += data.length;
  }
  return { map, stored };
}

async function audit(message, metadata) {
  const { error } = await db.from("audit_events").insert({ event_type: "initial_import", message, metadata });
  if (error) console.warn("audit insert failed:", error.message);
}

// --- main ---------------------------------------------------------------
const accountsConfig = moduleMap.accounts;
const contactsConfig = moduleMap.contacts;
const dealsConfig = moduleMap.deals;
const accountsCsv = load(accountsConfig.sourceFile);
const contactsCsv = load(contactsConfig.sourceFile);
const dealsCsv = load(dealsConfig.sourceFile);
console.log(`read: ${accountsCsv.length} accounts, ${contactsCsv.length} contacts, ${dealsCsv.length} deals`);

// accounts
const accCol = accountsConfig.csvColumns;
const accRows = accountsCsv.map(r => ({
  [accountsConfig.zohoIdColumn]: nn(r[accCol.zohoId]),
  zoho_url: nn(r[accCol.zohoUrl]),
  [accountsConfig.nameColumn]: r[accCol.name],
  website: nn(r[accCol.website]),
  phone: nn(r[accCol.phone]),
  industry: nn(r[accCol.industry]),
  owner: nn(r[accCol.owner]),
  source: "master_import",
  raw_data: r
})).filter(r => r[accountsConfig.zohoIdColumn] && r[accountsConfig.nameColumn]);
const acc = await upsert(accountsConfig.table, accRows, accountsConfig.zohoIdColumn, accountsConfig.zohoIdColumn);
console.log(`accounts: stored ${acc.stored}`);
await audit(`Imported ${acc.stored} accounts from ${accountsConfig.sourceFile}`, { module: "accounts", stored: acc.stored });

// contacts
let cLinked = 0;
const conCol = contactsConfig.csvColumns;
const conRows = contactsCsv.map(r => {
  const account_id = acc.map.get(r[conCol.accountZohoId]) ?? null;
  if (account_id) cLinked++;
  return {
    [contactsConfig.zohoIdColumn]: nn(r[conCol.zohoId]),
    zoho_url: nn(r[conCol.zohoUrl]),
    account_id,
    first_name: nn(r[conCol.firstName]),
    last_name: nn(r[conCol.lastName]),
    [contactsConfig.nameColumn]: r[conCol.fullName],
    email: nn(r[conCol.email]),
    title: nn(r[conCol.title]),
    phone: nn(r[conCol.phone]),
    mobile: nn(r[conCol.mobile]),
    owner: nn(r[conCol.owner]),
    source: "master_import",
    raw_data: r
  };
}).filter(r => r[contactsConfig.zohoIdColumn] && r[contactsConfig.nameColumn]);
const con = await upsert(contactsConfig.table, conRows, contactsConfig.zohoIdColumn, contactsConfig.zohoIdColumn);
console.log(`contacts: stored ${con.stored}, account-linked ${cLinked}, unlinked ${conRows.length - cLinked}`);
await audit(`Imported ${con.stored} contacts (${cLinked} linked to accounts)`, { module: "contacts", stored: con.stored, linked: cLinked });

// deals
let dAcc = 0, dCon = 0;
const dealCol = dealsConfig.csvColumns;
const dealRows = dealsCsv.map(r => {
  const account_id = acc.map.get(r[dealCol.accountZohoId]) ?? null;
  const primary_contact_id = con.map.get(r[dealCol.primaryContactZohoId]) ?? null;
  if (account_id) dAcc++;
  if (primary_contact_id) dCon++;
  return {
    [dealsConfig.zohoIdColumn]: nn(r[dealCol.zohoId]),
    zoho_url: nn(r[dealCol.zohoUrl]),
    account_id,
    primary_contact_id,
    [dealsConfig.nameColumn]: r[dealCol.name],
    stage: nn(r[dealCol.stage]),
    next_step: nn(r[dealCol.nextStep]),
    owner: nn(r[dealCol.owner]),
    closing_date: nn(r[dealCol.closingDate]),
    amount: num(r[dealCol.amount]),
    source: "master_import",
    raw_data: r
  };
}).filter(r => r[dealsConfig.zohoIdColumn] && r[dealsConfig.nameColumn]);
const dl = await upsert(dealsConfig.table, dealRows, dealsConfig.zohoIdColumn, dealsConfig.zohoIdColumn);
console.log(`deals: stored ${dl.stored}, account-linked ${dAcc}, contact-linked ${dCon}`);
await audit(`Imported ${dl.stored} deals (${dAcc} account-linked, ${dCon} contact-linked)`, { module: "deals", stored: dl.stored, accountLinked: dAcc, contactLinked: dCon });

console.log("done.");
