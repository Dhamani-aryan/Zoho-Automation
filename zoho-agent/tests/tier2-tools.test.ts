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
import {
  compareZohoApiReadBack,
  isBlockedZohoApiPath,
  isAllowedZohoApiPath,
  isZohoApiWriteArgs,
  moduleFromZohoApiPath,
  shapeZohoApiResponse,
  zohoApiReadSchema,
  zohoApiWriteTargets
} from "../lib/agent/zoho-api";
import {
  isPlainEnterKey,
  isScheduleControl,
  isSendNowControl
} from "../extension/src/send-guard";
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
  assert.match(source, /job\.tool_name === "browser_navigate"/);
  assert.match(source, /job\.tool_name === "browser_screenshot"/);
  assert.match(source, /job\.tool_name === "browser_input"/);
  assert.match(source, /chrome\.windows\.create\(\{ url, focused: false/);
  assert.doesNotMatch(source, /focused: true/);
  assert.doesNotMatch(source, /state: "normal"/);
  assert.doesNotMatch(source, /active: true/);
  assert.doesNotMatch(source, /chrome\.windows\.update/);
  assert.match(source, /Page\.captureScreenshot/);
  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /Input\.dispatchKeyEvent/);
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

test("zoho_api validates allowlisted CRM paths and rejects unsafe methods or paths", () => {
  assert.equal(isAllowedZohoApiPath("/crm/v3/Deals/6834250000003329005"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v3/Accounts/6834250000000000001/Contacts"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v3/Tasks/search"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v2.2/Contacts/6834250000000000001"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v2.2/Tasks", "POST"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v2.2/Deals/6834250000000000001/actions/add_tags", "POST"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v3/settings/fields"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v3/users"), true);
  assert.equal(isAllowedZohoApiPath("/crm/v3/Vendors"), false);
  assert.equal(isAllowedZohoApiPath("/crm/v3/Deals/6834250000000000001/actions/delete"), false);
  assert.equal(isAllowedZohoApiPath("/crm/v2.2/Deals/6834250000000000001/actions/send_mail", "POST"), false);
  assert.equal(isBlockedZohoApiPath("/crm/v3/Deals/6834250000000000001/actions/delete"), true);
  assert.equal(isBlockedZohoApiPath("/crm/v2.2/Deals/6834250000000000001/actions/send_mail"), true);
  assert.equal(moduleFromZohoApiPath("/crm/v3/Deals/6834250000003329005"), "Deals");

  assert.deepEqual(zohoApiReadSchema.parse({ method: "get", path: "/crm/v3/Deals", params: { page: 1 } }), {
    method: "GET",
    path: "/crm/v3/Deals",
    params: { page: "1" }
  });
  assert.deepEqual(
    zohoApiReadSchema.parse({ method: "PUT", path: "/crm/v2.2/Deals", body: { data: [{ id: "D1", Stage: "Follow-Up" }] } }),
    {
      method: "PUT",
      path: "/crm/v2.2/Deals",
      params: {},
      body: { data: [{ id: "D1", Stage: "Follow-Up" }] }
    }
  );
  assert.equal(isZohoApiWriteArgs({ method: "PUT" }), true);
  assert.equal(isZohoApiWriteArgs({ method: "GET" }), false);
  assert.throws(() => zohoApiReadSchema.parse({ method: "DELETE", path: "/crm/v3/Deals/1" }));
  assert.throws(() => zohoApiReadSchema.parse({ method: "GET", path: "/crm/v3/Vendors" }));
  assert.throws(() => zohoApiReadSchema.parse({ method: "GET", path: "/crm/v3/Deals", body: {} }));
  assert.throws(() => zohoApiReadSchema.parse({ method: "POST", path: "/crm/v2.2/Tasks" }));
  assert.throws(() =>
    zohoApiReadSchema.parse({
      method: "GET",
      path: "/crm/v3/Deals",
      params: Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`p${index}`, "x"]))
    })
  );
});

test("zoho_api H1 response shaping and extension runner fetch proof", () => {
  assert.deepEqual(shapeZohoApiResponse(204, null), { status: 204, empty: true });
  assert.deepEqual(shapeZohoApiResponse(200, { data: [] }), { status: 200, body: { data: [] } });

  const source = readFileSync(resolve(process.cwd(), "extension/src/page-runner-api.ts"), "utf8");
  const fetchCalls = source.match(/\bfetch\(/g) ?? [];
  assert.equal(fetchCalls.length, 1);
  assert.match(source, /method !== "GET" && method !== "POST" && method !== "PUT"/);
  assert.match(source, /blockedPath/);
  assert.match(source, /body === undefined/);
  assert.match(source, /status: 204, empty: true/);
  assert.match(source, /X-ZCSRF-TOKEN/);
  assert.match(source, /X-CRM-ORG/);

  const jobsSource = readFileSync(resolve(process.cwd(), "extension/src/jobs.ts"), "utf8");
  assert.match(jobsSource, /zohoApiPageRunner/);
  assert.match(jobsSource, /job\.tool_name === "zoho_api"/);
  assert.match(jobsSource, /method !== "GET" && !job\.approval_id && !job\.task_order_id/);

  const claimSource = readFileSync(resolve(process.cwd(), "app/api/ext/jobs/claim/route.ts"), "utf8");
  assert.match(claimSource, /isZohoApiWriteArgs/);
  assert.match(claimSource, /isZohoApiWriteJob/);

  const approvalSource = readFileSync(resolve(process.cwd(), "app/api/agent/approvals/[id]/route.ts"), "utf8");
  assert.match(approvalSource, /decided\.tool_name === "zoho_api"/);
  assert.match(approvalSource, /isZohoApiWriteArgs/);
});

test("send-now guard blocks trusted clicks, exact send controls, and focused enter", () => {
  assert.equal(isSendNowControl({ ariaLabel: "Send", role: "button" }), true);
  assert.equal(isSendNowControl({ ariaLabel: "Send email", role: "button" }), true);
  assert.equal(isSendNowControl({ text: "Send now", role: "button" }), true);
  assert.equal(isSendNowControl({ text: "Resend", role: "button" }), false);
  assert.equal(isSendNowControl({ text: "Send test", role: "button" }), false);
  assert.equal(isSendNowControl({ text: "Schedule", role: "button" }), false);
  assert.equal(isScheduleControl({ text: "Schedule & Close", role: "button" }), true);
  assert.equal(isPlainEnterKey("Enter"), true);

  const guardSource = readFileSync(resolve(process.cwd(), "extension/src/send-guard.ts"), "utf8");
  assert.match(guardSource, /send-now is blocked; schedule instead/);
  assert.match(guardSource, /looksLikeSendNowEndpoint/);
  assert.match(guardSource, /isModifierEnterKey/);
  assert.match(guardSource, /isPlainEnterKey/);
  assert.match(guardSource, /isSendNowControl/);
  assert.match(guardSource, /name === "send email"/);

  const jobsSource = readFileSync(resolve(process.cwd(), "extension/src/jobs.ts"), "utf8");
  assert.match(jobsSource, /from "\.\/send-guard"/);
  assert.match(jobsSource, /assertSendGuardAllowsClick/);
  assert.match(jobsSource, /assertSendGuardAllowsFocusedEnter/);
  assert.match(jobsSource, /document\.elementFromPoint/);
  assert.match(jobsSource, /SEND_NOW_BLOCKED_MESSAGE/);
  assert.match(jobsSource, /window\.fetch =/);
  assert.match(jobsSource, /addEventListener\("click", clickGuard, true\)/);
  assert.match(jobsSource, /addEventListener\("keydown", keyGuard, true\)/);
  assert.match(jobsSource, /isModifierEnterKey\(key\)/);
  assert.match(jobsSource, /isPlainEnterKey\(key\)/);
  assert.match(jobsSource, /method !== "GET" && !job\.approval_id && !job\.task_order_id/);
});

test("composer browser gate is consulted before composer-driving browser tools", () => {
  const helperSource = readFileSync(resolve(process.cwd(), "lib/agent/browser-composer-gate.ts"), "utf8");
  assert.match(helperSource, /COMPOSER_INPUT_REQUIRES_APPROVAL/);
  assert.match(helperSource, /browserEvalIsProvablyReadOnly/);
  assert.match(helperSource, /composerBrowserGateDecision/);

  const jobsSource = readFileSync(resolve(process.cwd(), "extension/src/jobs.ts"), "utf8");
  assert.match(jobsSource, /from "\.\.\/\.\.\/lib\/agent\/browser-composer-gate"/);
  assert.match(jobsSource, /composerDetectedInTab/);
  assert.match(jobsSource, /enforceComposerBrowserGate/);
  assert.match(jobsSource, /#ceSubject_1,#ceToAddr_1,#ceCCAddr_1,#editorDiv,#ecw_signature,#z_editor/);
  assert.match(jobsSource, /job\.tool_name === "browser_eval"[\s\S]*enforceComposerBrowserGate/);
  assert.match(jobsSource, /job\.tool_name === "browser_input"[\s\S]*enforceComposerBrowserGate/);
});

test("agent composer instructions reconcile recipient chips by email attribute", () => {
  const loopSource = readFileSync(resolve(process.cwd(), "lib/agent/loop.ts"), "utf8");
  assert.match(loopSource, /identify To\/Cc chips only by the email attribute/);
  assert.match(loopSource, /\[id\^="ceToAddrDetails"\] li\.selectedEmail/);
  assert.match(loopSource, /never compare visible label text/);
  assert.match(loopSource, /If a pre-filled chip email already equals the resolved recipient, keep it and type nothing/);
  assert.match(loopSource, /poll the chip list for up to about 5 seconds/);
  assert.match(loopSource, /label "Loading", missing\/empty email attribute, or a pending\/loading class/);
  assert.match(loopSource, /deduplication, not ambiguity/);
  assert.match(loopSource, /Same rules apply for CC/);
});

test("Phase I soul prompt encodes autonomy, records, identity, and call economy", () => {
  const loopSource = readFileSync(resolve(process.cwd(), "lib/agent/loop.ts"), "utf8");
  assert.match(loopSource, /AUTONOMY OVER APPROVAL/);
  assert.match(loopSource, /reversible CRM work is not per-item permission work/);
  assert.match(loopSource, /GUARDRAILS/);
  assert.match(loopSource, /RECORDS NOT GATES/);
  assert.match(loopSource, /write_ok_unverified is not automatically a failed task/);
  assert.match(loopSource, /ADOPT DONT RECREATE/);
  assert.match(loopSource, /VERIFY BY IDENTITY/);
  assert.match(loopSource, /autocomplete can hijack Enter/);
  assert.match(loopSource, /dismiss the dropdown with Escape/);
  assert.match(loopSource, /red or invalid chip is failure evidence, never success/);
  assert.match(loopSource, /composer may autosave a Draft once touched; ignore Drafts as evidence/);
  assert.match(loopSource, /Verdana around 13\.3px/);
  assert.match(loopSource, /parse the attachment once/);
  assert.match(loopSource, /ONE db\/mirror or zoho_api search per identity/);
  assert.match(loopSource, /API-only receipt verification and no browser verification for API writes/);
  assert.match(loopSource, /ONE rich read-only browser_eval observation bundle per composer state/);
  assert.match(loopSource, /one scheduled-artifact read-back/);
  assert.match(loopSource, /Repeated thin observations are a smell/);
  assert.match(loopSource, /Target the one-email-two-task run at 10-14 tool calls/);
});

test("agent task instructions require duplicate-check before task creation", () => {
  const loopSource = readFileSync(resolve(process.cwd(), "lib/agent/loop.ts"), "utf8");
  assert.match(loopSource, /Before any zoho_api POST \/crm\/v3\/Tasks/);
  assert.match(loopSource, /GET \/crm\/v3\/Tasks in bounded pages/);
  assert.match(loopSource, /Tasks\/search scoped to the Deal through What_Id/);
  assert.match(loopSource, /do not already exist as an open task with the same subject/);
  assert.match(loopSource, /Requested completions that already show Completed are adopted as verified, not re-created/);
  assert.match(loopSource, /duplicate-check requested Tasks against the exact Deal before any POST/);
});

test("agent schedule popup instructions require live observation and Scheduled verification", () => {
  const loopSource = readFileSync(resolve(process.cwd(), "lib/agent/loop.ts"), "utf8");
  assert.match(loopSource, /Schedule popup method/);
  assert.match(loopSource, /observe the live composer bottom controls before clicking/);
  assert.match(loopSource, /Schedule control is near Send/);
  assert.match(loopSource, /#schTimeMail/);
  assert.match(loopSource, /"8:00 PM" and "08:00 PM"/);
  assert.match(loopSource, /post-midnight times as rolling to the next calendar day/);
  assert.match(loopSource, /"Schedule & Close"/);
  assert.match(loopSource, /Emails -> Scheduled list or the internal scheduled-mail read-back/);
});

test("composer scheduling verification is recorded as a completion flag", () => {
  const helperSource = readFileSync(resolve(process.cwd(), "lib/agent/scheduled-email-verification.ts"), "utf8");
  assert.match(helperSource, /scheduledEmailCompletionDecision/);
  assert.match(helperSource, /SCHEDULED_EMAIL_READBACK_REQUIRED/);
  assert.match(helperSource, /extractScheduledEmailVerification/);
  assert.match(helperSource, /hasComposerBrowserMutation/);
  assert.match(helperSource, /scheduled_email_verification_missing/);
  assert.match(helperSource, /flag it and continue/);

  const bridgeSource = readFileSync(resolve(process.cwd(), "lib/agent/bridge.ts"), "utf8");
  assert.match(bridgeSource, /taskOrderId\?: string \| null/);
  assert.match(bridgeSource, /task_order_id: taskOrderId/);

  const loopSource = readFileSync(resolve(process.cwd(), "lib/agent/loop.ts"), "utf8");
  assert.match(loopSource, /recordScheduledEmailVerificationIfPresent/);
  assert.match(loopSource, /event_type: "composer_browser_mutation"/);
  assert.match(loopSource, /event_type: "scheduled_email_verified"/);
  assert.match(loopSource, /composerBrowserMutationStatsForOrder/);
  assert.match(loopSource, /scheduledEmailVerificationCountForOrder/);
  assert.match(loopSource, /verification_flags/);
  assert.match(loopSource, /scheduled_email_verification_missing/);
  assert.match(loopSource, /has_unverified_receipts/);

  const jobsSource = readFileSync(resolve(process.cwd(), "extension/src/jobs.ts"), "utf8");
  assert.match(jobsSource, /withComposerGateResult/);
  assert.match(jobsSource, /composer_gate/);
  assert.match(jobsSource, /state_changing/);
});

test("zoho_api write receipts can derive targets and compare read-back fields", () => {
  const targets = zohoApiWriteTargets(
    {
      method: "POST",
      path: "/crm/v2.2/Tasks",
      body: { data: [{ Subject: "Follow up", Status: "Not Started" }] }
    },
    { body: { data: [{ code: "SUCCESS", details: { id: "T1" } }] } }
  );
  assert.deepEqual(targets, [
    { module: "Tasks", id: "T1", fields: { Subject: "Follow up", Status: "Not Started" } }
  ]);

  assert.deepEqual(compareZohoApiReadBack({ Subject: "Follow up" }, { Subject: "Follow up", id: "T1" }), {
    verified: true,
    verified_fields: { Subject: "Follow up" },
    mismatches: []
  });
  assert.deepEqual(compareZohoApiReadBack({ Status: "Completed" }, { Status: "Not Started" }), {
    verified: false,
    verified_fields: {},
    mismatches: ["Status"]
  });

  const loopSource = readFileSync(resolve(process.cwd(), "lib/agent/loop.ts"), "utf8");
  assert.match(loopSource, /withZohoApiReceipts/);
  assert.match(loopSource, /zohoApiReceiptStatsForOrder/);
  assert.match(loopSource, /zoho_api_batch_readback/);
  assert.match(loopSource, /ids: ids\.join/);
  assert.match(loopSource, /verification_flags/);
  assert.match(loopSource, /zero_receipt_mutations/);
  assert.doesNotMatch(loopSource, /require at least one verification receipt/);
});

test("Phase H6 model-facing tool surface is agent-first", () => {
  const tier1Source = readFileSync(resolve(process.cwd(), "lib/agent/tier1-tools.ts"), "utf8");
  assert.match(tier1Source, /tool\.name === "zoho_api" \|\| tool\.name === "db_sync_records"/);

  const loopSource = readFileSync(resolve(process.cwd(), "lib/agent/loop.ts"), "utf8");
  assert.doesNotMatch(loopSource, /\.\.\.TIER2_TOOL_DEFINITIONS/);
  assert.doesNotMatch(loopSource, /\.\.\.EMAIL_SCHEDULING_TOOL_DEFINITIONS/);
  assert.match(loopSource, /Use zoho_api POST\/PUT for CRM writes/);
  assert.match(loopSource, /Email composer recipient reconciliation method/);
});
