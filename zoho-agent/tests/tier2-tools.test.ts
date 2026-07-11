import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TIER2_WRITE_TOOL_NAMES,
  validateTier2Call,
  tier2RecordIds,
  approvalGatedClaimDecision,
  assertTier2JobInsertAllowed,
  tier2ClaimDecision,
  extensionAcceptsWriteJob,
  isTier2WriteTool,
  type PreparedTier2
} from "../lib/agent/tier2-tools";
import type { FieldMetaRow } from "../lib/plan/field-rules";

const fieldMeta: FieldMetaRow[] = [
  { module: "Deals", api_name: "Deal_Name" },
  { module: "Deals", api_name: "Next_Step" },
  {
    module: "Deals",
    api_name: "Stage",
    data_type: "picklist",
    picklist_values: [{ actual_value: "Follow-Up" }, { actual_value: "Closed Won" }]
  },
  { module: "Deals", api_name: "Closing_Date", data_type: "date" },
  { module: "Deals", api_name: "Amount", data_type: "currency" },
  { module: "Contacts", api_name: "Email", data_type: "email" },
  { module: "Contacts", api_name: "Full_Name" },
  { module: "Deals", api_name: "Owner", data_type: "ownerlookup" },
  { module: "Deals", api_name: "Account_Name", data_type: "lookup" }
];

function call(name: string, args: Record<string, unknown>) {
  return { id: "call-1", name, args };
}

test("accepts a plain field update and normalizes the module", () => {
  const prepared = validateTier2Call(
    call("zoho_update_fields", { module: "deals", updates: [{ zoho_id: "D1", fields: { Next_Step: "3rd Email" } }] }),
    { fieldMeta, role: "operator" }
  ) as Extract<PreparedTier2, { tool_name: "zoho_update_fields" }>;

  assert.equal(prepared.tool_name, "zoho_update_fields");
  assert.equal(prepared.module, "Deals");
  assert.deepEqual(prepared.records, [{ zoho_id: "D1", fields: { Next_Step: "3rd Email" } }]);
  assert.deepEqual(tier2RecordIds(prepared), ["D1"]);
});

test("blocks Deal_Name edits for everyone", () => {
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Deal_Name: "New" } }] }), {
        fieldMeta,
        role: "admin"
      }),
    /Deal_Name cannot be changed/
  );
});

test("Stage is admin-only", () => {
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Stage: "Closed Won" } }] }), {
        fieldMeta,
        role: "operator"
      }),
    /requires an admin role/
  );

  const prepared = validateTier2Call(
    call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Stage: "Closed Won" } }] }),
    { fieldMeta, role: "admin" }
  );
  assert.equal(prepared.tool_name, "zoho_update_fields");
});

test("blocks lookup fields in zoho_update_fields", () => {
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Owner: "6834250000003103001" } }] }), {
        fieldMeta,
        role: "admin"
      }),
    /use zoho_change_owner/
  );
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Account_Name: "some-id" } }] }), {
        fieldMeta,
        role: "admin"
      }),
    /lookup field/
  );
});

test("rejects a value outside a picklist", () => {
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Stage: "Nope" } }] }), {
        fieldMeta,
        role: "admin"
      }),
    /not an allowed option for Stage/
  );
});

test("rejects an unknown field", () => {
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Bogus: "x" } }] }), {
        fieldMeta,
        role: "admin"
      }),
    /Unknown Deals field: Bogus/
  );
});

test("validates email format and date shape", () => {
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Contacts", updates: [{ zoho_id: "C1", fields: { Email: "not-an-email" } }] }), {
        fieldMeta,
        role: "operator"
      }),
    /not a valid email/
  );
  assert.throws(
    () =>
      validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Closing_Date: "08/31/2026" } }] }), {
        fieldMeta,
        role: "operator"
      }),
    /not a valid date/
  );
  // Valid ISO date passes.
  validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: { Closing_Date: "2026-08-31" } }] }), {
    fieldMeta,
    role: "operator"
  });
});

test("resolves a known owner and rejects an unknown one", () => {
  const prepared = validateTier2Call(call("zoho_change_owner", { module: "Deals", zoho_ids: ["D1", "D1"], owner_name: "Aryan" }), {
    fieldMeta,
    role: "operator"
  }) as Extract<PreparedTier2, { tool_name: "zoho_change_owner" }>;
  assert.equal(prepared.owner.name, "Aryan Dhamani");
  assert.equal(prepared.owner.id, "6834250000001208001");
  assert.deepEqual(prepared.zoho_ids, ["D1"]); // deduped

  assert.throws(
    () => validateTier2Call(call("zoho_change_owner", { module: "Deals", zoho_ids: ["D1"], owner_name: "Nobody Real" }), { fieldMeta, role: "operator" }),
    /not a known CRM user/
  );
});

test("normalizes tag add/remove", () => {
  const prepared = validateTier2Call(call("zoho_add_tags", { module: "Deals", zoho_ids: ["D1"], tags: ["hot", "hot", "q3"] }), {
    fieldMeta,
    role: "operator"
  }) as Extract<PreparedTier2, { tool_name: "zoho_add_tags" | "zoho_remove_tags" }>;
  assert.deepEqual(prepared.tags, ["hot", "q3"]);
});

test("rejects empty updates and too-many records", () => {
  assert.throws(() => validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: [{ zoho_id: "D1", fields: {} }] }), { fieldMeta, role: "admin" }));
  const many = Array.from({ length: 51 }, (_, i) => ({ zoho_id: `D${i}`, fields: { Next_Step: "x" } }));
  assert.throws(() => validateTier2Call(call("zoho_update_fields", { module: "Deals", updates: many }), { fieldMeta, role: "admin" }));
});

// --- Belt-and-braces guards (negative proofs) ---

test("assertTier2JobInsertAllowed blocks a Tier-2 write without approval_id", () => {
  assert.throws(() => assertTier2JobInsertAllowed("zoho_update_fields", null), /without an approved/);
  assert.throws(() => assertTier2JobInsertAllowed("zoho_change_owner", undefined), /without an approved/);
  // Tier-1 read is fine without approval.
  assert.doesNotThrow(() => assertTier2JobInsertAllowed("zoho_get_record", null));
  // Tier-2 write WITH an approval id is fine.
  assert.doesNotThrow(() => assertTier2JobInsertAllowed("zoho_update_fields", "approval-1"));
});

test("tier2ClaimDecision only clears Tier-2 jobs whose approval is approved", () => {
  assert.deepEqual(tier2ClaimDecision({ tool_name: "zoho_get_record", approval_id: null }, null).claimable, true);
  assert.deepEqual(tier2ClaimDecision({ tool_name: "zoho_update_fields", approval_id: null }, null).claimable, false);
  assert.deepEqual(tier2ClaimDecision({ tool_name: "zoho_update_fields", approval_id: "a1" }, "pending").claimable, false);
  assert.deepEqual(tier2ClaimDecision({ tool_name: "zoho_update_fields", approval_id: "a1" }, "rejected").claimable, false);
  assert.deepEqual(tier2ClaimDecision({ tool_name: "zoho_update_fields", approval_id: "a1" }, "approved").claimable, true);
});

test("approvalGatedClaimDecision gates write-effect ui_workflow jobs like Tier-2 writes", () => {
  assert.equal(approvalGatedClaimDecision({ approval_id: null }, null).claimable, false);
  assert.equal(approvalGatedClaimDecision({ approval_id: "a1" }, "pending").claimable, false);
  assert.equal(approvalGatedClaimDecision({ approval_id: "a1" }, "rejected").claimable, false);
  assert.equal(approvalGatedClaimDecision({ approval_id: "a1" }, null).claimable, false);
  assert.equal(approvalGatedClaimDecision({ approval_id: "a1" }, "approved").claimable, true);
});

test("extensionAcceptsWriteJob refuses a write job lacking approval_id or task_order_id", () => {
  assert.equal(extensionAcceptsWriteJob({ tool_name: "zoho_add_tags", approval_id: null }), false);
  assert.equal(extensionAcceptsWriteJob({ tool_name: "zoho_add_tags", approval_id: "a1" }), true);
  assert.equal(extensionAcceptsWriteJob({ tool_name: "zoho_add_tags", task_order_id: "o1" }), true);
  assert.equal(extensionAcceptsWriteJob({ tool_name: "zoho_search" }), true);
  assert.equal(isTier2WriteTool("zoho_change_owner"), true);
  assert.equal(isTier2WriteTool("zoho_get_record"), false);
});

test("extension WRITE_TOOLS stays in sync with Tier-2 write tool names", () => {
  const source = readFileSync(resolve(process.cwd(), "extension/src/jobs.ts"), "utf8");
  const match = source.match(/const WRITE_TOOLS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(match, "extension WRITE_TOOLS literal was not found");
  const extensionNames = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
  assert.deepEqual(extensionNames, [...TIER2_WRITE_TOOL_NAMES, "schedule_zoho_email"].sort());
  assert.match(source, /job\.tool_name === "schedule_zoho_email"/);
  assert.match(source, /write without approval or task order refused by extension/);
  assert.match(source, /prepareDealTasksWithApi/);
  assert.match(source, /tool_name: "zoho_prepare_tasks"/);
  assert.match(source, /task_receipt_missing/);
  assert.match(source, /recovery_attempts: 2/);
  assert.match(source, /receipt\.status === "write_ok_unverified"/);
  assert.doesNotMatch(source, /markAsCompletedIcon/);
  assert.doesNotMatch(source, /task_subject/);
});

test("extension browser jobs stay in a dedicated background window", () => {
  const source = readFileSync(resolve(process.cwd(), "extension/src/jobs.ts"), "utf8");
  assert.match(source, /requiresDedicatedAgentWindow/);
  assert.match(source, /chrome\.windows\.create\(\{ url, focused: false/);
  assert.doesNotMatch(source, /focused: true/);
  assert.doesNotMatch(source, /state: "normal"/);
  assert.doesNotMatch(source, /active: true/);
  assert.doesNotMatch(source, /chrome\.windows\.update/);
});

test("Zoho task preparation uses API writes with supported deal-scoped task read-back", () => {
  const source = readFileSync(resolve(process.cwd(), "extension/src/page-runner-write.ts"), "utf8");
  assert.match(source, /job\.tool_name === "zoho_prepare_tasks"/);
  assert.match(source, /request\("POST", "\/crm\/v2\.2\/Tasks"/);
  assert.match(source, /request\("PUT", "\/crm\/v2\.2\/Tasks"/);
  assert.match(source, /request\("GET", "\/crm\/v3\/Tasks"/);
  assert.match(source, /lookupId\(task\.What_Id\) === dealId/);
  assert.match(source, /per_page: "200"/);
  assert.doesNotMatch(source, /Activities_Chronological_View/);
  assert.match(source, /getRecord\("Tasks", taskId/);
  assert.match(source, /\$se_module: "Deals"/);
  assert.match(source, /"write_ok_unverified"/);
  assert.match(source, /"adopt-history"/);
  assert.match(source, /receipts/);
  assert.match(source, /JSON\.parse\(JSON\.stringify\(result\)\)/);
});
