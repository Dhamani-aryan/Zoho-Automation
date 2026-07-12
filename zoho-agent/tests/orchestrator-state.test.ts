import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLAIM_STALE_MS,
  canApproveRun,
  canClaimItem,
  canClaimRun,
  canReportItem,
  canTransitionRun,
  computeStopDecision,
  nextItemClaim,
  statusAfterClaim,
  statusAfterReport
} from "../lib/orchestrator/state";
import {
  approvalExpiryPatch,
  queuedJobExpiryPatch,
  runningJobStalePatch,
  sweepCutoffs
} from "../lib/agent/sweeps";
import { turnActiveUntil, turnClaimDecision } from "../lib/agent/turn-lock";
import {
  prepareUiWorkflow,
  prepareUiWorkflowReplay,
  uiStepTeachModeDecision,
  validateUiToolCall,
  workflowEffectForSteps
} from "../lib/agent/ui-tools";
import {
  defaultTaskOrderBudget,
  expandedAgentLimits,
  taskOrderBudgetDecision,
  taskOrderProposalDecision,
  taskOrderRecordUsage
} from "../lib/agent/task-orders";
import { responsesInputFromMessages } from "../lib/llm/tool-calls";
import { routeCoreSkillGuides } from "../lib/agent/guide-routing";
import {
  readWorkspaceTextFile,
  resolveWorkspaceFilePath,
  workspaceRootFromCwd
} from "../lib/agent/workspace-files";
import { verifiedWriteFollowup } from "../lib/agent/tier2-tools";
import { normalizeZohoReadFields } from "../lib/agent/zoho-read-fields";
import {
  isEmailSchedulingExtensionJob,
  scheduleZohoEmailBatchSchema
} from "../lib/agent/email-scheduling-tools";
import {
  allowsToolAfterTaskPreparationFailure,
  hasTaskPreparationFailure
} from "../lib/agent/email-recovery-policy";
import { validateBrowserToolCall } from "../lib/agent/browser-tools";
import {
  browserEvalIsProvablyReadOnly,
  composerBrowserGateDecision
} from "../lib/agent/browser-composer-gate";
import {
  extractScheduledEmailVerification,
  hasComposerBrowserMutation,
  scheduledEmailCompletionDecision
} from "../lib/agent/scheduled-email-verification";

test("workspace file reader is confined, paginated, and can read the real drafts", async () => {
  const workspaceRoot = workspaceRootFromCwd(process.cwd());
  assert.match(
    resolveWorkspaceFilePath(workspaceRoot, "imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md"),
    /KD Blitz Batch 3 All Contacts Email Drafts\.md$/
  );
  assert.match(
    resolveWorkspaceFilePath(workspaceRoot, "imports/samples/Test SAP ERP Email Draft.md"),
    /zoho-agent[\\/]imports[\\/]samples[\\/]Test SAP ERP Email Draft\.md$/
  );
  assert.match(
    resolveWorkspaceFilePath(workspaceRoot, "reference/heysnap/COMPOSER_METHOD.md"),
    /reference[\\/]heysnap[\\/]COMPOSER_METHOD\.md$/
  );
  assert.throws(() => resolveWorkspaceFilePath(workspaceRoot, "../secrets.txt"), /outside allowed roots/);
  assert.throws(() => resolveWorkspaceFilePath(workspaceRoot, "imports/samples/secret.exe"), /type is not allowed/);

  const page = await readWorkspaceTextFile(workspaceRoot, {
    path: "imports/samples/KD Blitz Batch 3 All Contacts Email Drafts.md",
    start_line: 1,
    max_lines: 20
  });
  assert.equal(page.source, "workspace_file");
  assert.match(page.content, /KD Blitz Batch 3 All Contacts Email Drafts/);
  assert.match(page.content, /Schedule date: TBD/);
  assert.equal(typeof page.next_start_line, "number");

  const selfResolving = readFileSync(resolve(process.cwd(), "imports/samples/Test SAP ERP Email Draft.md"), "utf8");
  assert.match(selfResolving, /Contact name: Test Test/);
  assert.match(selfResolving, /New tasks:/);
  assert.match(selfResolving, /Tasks to complete:/);
  assert.doesNotMatch(selfResolving, /Zoho record link:/);
  assert.doesNotMatch(selfResolving, /^To:/m);

  const attachmentDir = join(homedir(), ".codex", "attachments", `read-workspace-file-test-${process.pid}`);
  const attachmentPath = join(attachmentDir, "attached-draft.txt");
  try {
    mkdirSync(attachmentDir, { recursive: true });
    writeFileSync(attachmentPath, "Attached draft line 1\nAttached draft line 2\n", "utf8");
    const attachmentPage = await readWorkspaceTextFile(workspaceRoot, {
      path: attachmentPath,
      start_line: 1,
      max_lines: 1
    });
    assert.equal(attachmentPage.path, attachmentPath.replace(/\\/g, "/"));
    assert.equal(attachmentPage.content, "Attached draft line 1");
    assert.equal(attachmentPage.next_start_line, 2);
  } finally {
    rmSync(attachmentDir, { recursive: true, force: true });
  }
});

test("core playbooks route deterministically and carry recent intent", () => {
  assert.deepEqual(routeCoreSkillGuides("email"), { names: ["email-scheduling"], source: "current" });
  assert.deepEqual(routeCoreSkillGuides("deal"), { names: ["deals-editing"], source: "current" });
  assert.deepEqual(routeCoreSkillGuides("contact"), { names: ["contacts-editing"], source: "current" });
  assert.deepEqual(routeCoreSkillGuides("account"), { names: ["accounts-editing"], source: "current" });
  assert.deepEqual(routeCoreSkillGuides("Email this contact"), {
    names: ["email-scheduling", "contacts-editing"],
    source: "current"
  });
  assert.deepEqual(routeCoreSkillGuides("Try now", ["Open the deal", "Compose the email"]), {
    names: ["email-scheduling"],
    source: "recent"
  });
  assert.deepEqual(routeCoreSkillGuides("Continue"), { names: [], source: "none" });
});

test("Responses transcript includes only complete tool call/output pairs", () => {
  const input = responsesInputFromMessages([
    { role: "user", content: "Start" },
    { role: "tool_call", content: "", toolName: "browser_eval", callId: "paired", args: { code: "return 1" } },
    { role: "tool", content: "{\"result\":1}", toolName: "browser_eval", callId: "paired" },
    { role: "tool_call", content: "", toolName: "undo_task", callId: "missing-output", args: {} },
    { role: "tool", content: "orphaned result", toolName: "browser_observe", callId: "missing-call" }
  ]);

  assert.equal(input.some((item) => item.type === "function_call" && item.call_id === "paired"), true);
  assert.equal(input.some((item) => item.type === "function_call_output" && item.call_id === "paired"), true);
  assert.equal(input.some((item) => item.call_id === "missing-output"), false);
  assert.equal(input.some((item) => item.type === "function_call_output" && item.call_id === "missing-call"), false);
  assert.equal(
    input.some(
      (item) =>
        item.type === "message" &&
        Array.isArray(item.content) &&
        (item.content as Array<{ text?: string }>).some((part) => part.text?.includes("orphaned result"))
    ),
    true
  );
});

test("run transitions allow only the Phase 3 lifecycle", () => {
  assert.equal(canTransitionRun("preview_ready", "approved"), true);
  assert.equal(canTransitionRun("approved", "running"), true);
  assert.equal(canTransitionRun("running", "paused"), true);
  assert.equal(canTransitionRun("paused", "running"), true);
  assert.equal(canTransitionRun("running", "completed"), true);
  assert.equal(canTransitionRun("approved", "cancelled"), true);

  assert.equal(canTransitionRun("draft", "approved"), false);
  assert.equal(canTransitionRun("preview_ready", "running"), false);
  assert.equal(canTransitionRun("completed", "running"), false);
});

test("write runs require preview_ready before approval", () => {
  assert.equal(canApproveRun({ status: "preview_ready", runKind: "write", approvalRequired: true }), true);
  assert.equal(canApproveRun({ status: "draft", runKind: "write", approvalRequired: true }), false);
  assert.equal(canApproveRun({ status: "preview_ready", runKind: "read", approvalRequired: false }), false);
});

test("claiming starts approved runs and preserves running runs", () => {
  assert.equal(canClaimRun("approved"), true);
  assert.equal(canClaimRun("running"), true);
  assert.equal(canClaimRun("paused"), false);
  assert.equal(statusAfterClaim("approved"), "running");
  assert.equal(statusAfterClaim("running"), "running");
});

test("items claim from pending or stale running only", () => {
  const now = new Date("2026-07-05T12:10:00.000Z");
  const fresh = new Date(now.getTime() - CLAIM_STALE_MS + 1000).toISOString();
  const stale = new Date(now.getTime() - CLAIM_STALE_MS - 1000).toISOString();

  assert.equal(canClaimItem({ status: "pending", attempts: 0, now }), true);
  assert.equal(canClaimItem({ status: "running", attempts: 1, claimedAt: stale, now }), true);
  assert.equal(canClaimItem({ status: "running", attempts: 1, claimedAt: fresh, now }), false);
  assert.equal(canClaimItem({ status: "pending", attempts: 2, now }), false);

  assert.deepEqual(nextItemClaim({ status: "pending", attempts: 0, now }), {
    status: "running",
    attempts: 1,
    claimedAt: now.toISOString()
  });
});

test("items report only from running to terminal item statuses", () => {
  assert.equal(canReportItem("running", "success"), true);
  assert.equal(canReportItem("running", "skipped"), true);
  assert.equal(canReportItem("running", "failed"), true);
  assert.equal(canReportItem("pending", "success"), false);
  assert.equal(canReportItem("running", "needs_review"), false);
});

test("stop rules pause on explicit stop, consecutive failures, or failure rate", () => {
  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["success"],
      doneCount: 1,
      failedCount: 0,
      stopRun: true,
      stopReason: "zoho_logged_out"
    }),
    { pause: true, reason: "zoho_logged_out" }
  );

  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["failed", "failed", "failed"],
      doneCount: 3,
      failedCount: 3
    }),
    { pause: true, reason: "3 consecutive failed items" }
  );

  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["success", "failed"],
      doneCount: 10,
      failedCount: 3
    }),
    { pause: true, reason: "failure rate exceeded 20%" }
  );

  assert.deepEqual(
    computeStopDecision({
      recentDoneStatuses: ["success", "failed"],
      doneCount: 9,
      failedCount: 3
    }),
    { pause: false, reason: null }
  );
});

test("run status after report pauses, completes, or keeps running", () => {
  assert.equal(
    statusAfterReport({ currentRunStatus: "running", pendingCount: 2, runningCount: 0, pause: false }),
    "running"
  );
  assert.equal(
    statusAfterReport({ currentRunStatus: "running", pendingCount: 0, runningCount: 0, pause: false }),
    "completed"
  );
  assert.equal(
    statusAfterReport({ currentRunStatus: "running", pendingCount: 2, runningCount: 0, pause: true }),
    "paused"
  );
});

test("agent sweep cutoffs preserve Phase E retention windows", () => {
  const nowMs = Date.parse("2026-07-09T12:30:00.000Z");
  assert.deepEqual(sweepCutoffs(nowMs), {
    nowIso: "2026-07-09T12:30:00.000Z",
    pendingApprovalBeforeIso: "2026-07-09T12:15:00.000Z",
    queuedJobBeforeIso: "2026-07-09T12:20:00.000Z",
    runningJobBeforeIso: "2026-07-09T12:25:00.000Z"
  });

  assert.deepEqual(approvalExpiryPatch("2026-07-09T12:30:00.000Z"), {
    status: "expired",
    decided_at: "2026-07-09T12:30:00.000Z"
  });
  assert.equal(queuedJobExpiryPatch("2026-07-09T12:30:00.000Z").status, "expired");
  assert.equal(runningJobStalePatch("2026-07-09T12:30:00.000Z").status, "failed");
});

test("agent turn lock claims empty or expired sessions only", () => {
  const nowMs = Date.parse("2026-07-10T09:00:00.000Z");
  const turnTimeoutMs = 3 * 60 * 1000;
  const approvalWaitMs = 15 * 60 * 1000;
  const expectedUntil = "2026-07-10T09:18:00.000Z";

  assert.equal(turnActiveUntil({ nowMs, turnTimeoutMs, approvalWaitMs }), expectedUntil);
  assert.deepEqual(turnClaimDecision({ currentActiveUntil: null, nowMs, turnTimeoutMs, approvalWaitMs }), {
    claimable: true,
    activeUntilIso: expectedUntil
  });
  assert.deepEqual(
    turnClaimDecision({
      currentActiveUntil: "2026-07-10T08:59:59.000Z",
      nowMs,
      turnTimeoutMs,
      approvalWaitMs
    }),
    { claimable: true, activeUntilIso: expectedUntil }
  );
  assert.deepEqual(
    turnClaimDecision({
      currentActiveUntil: "2026-07-10T09:05:00.000Z",
      nowMs,
      turnTimeoutMs,
      approvalWaitMs
    }),
    { claimable: false, activeUntilIso: "2026-07-10T09:05:00.000Z" }
  );
});

test("task order budgets stop on tool, wall-clock, or record limits", () => {
  const order = {
    budget: { max_tool_calls: 3, max_wall_ms: 60_000, max_records_touched: 2 },
    decided_at: "2026-07-10T09:00:00.000Z",
    created_at: "2026-07-10T08:59:00.000Z"
  };

  assert.deepEqual(
    taskOrderBudgetDecision({
      order,
      nowMs: Date.parse("2026-07-10T09:00:30.000Z"),
      toolCalls: 2,
      recordsTouched: 2
    }),
    { ok: true }
  );
  assert.equal(
    taskOrderBudgetDecision({
      order,
      nowMs: Date.parse("2026-07-10T09:00:30.000Z"),
      toolCalls: 3,
      recordsTouched: 2
    }).ok,
    false
  );
  assert.equal(
    taskOrderBudgetDecision({
      order,
      nowMs: Date.parse("2026-07-10T09:02:01.000Z"),
      toolCalls: 1,
      recordsTouched: 1
    }).ok,
    false
  );
  assert.equal(
    taskOrderBudgetDecision({
      order,
      nowMs: Date.parse("2026-07-10T09:00:30.000Z"),
      toolCalls: 1,
      recordsTouched: 3
    }).ok,
    false
  );
});

test("task order record usage counts writes only and ignores nested read ids", () => {
  assert.equal(
    taskOrderRecordUsage("schedule_zoho_email_batch", {
      emails: [{ reference: "one" }, { reference: "two" }]
    }),
    2
  );
  assert.equal(
    taskOrderRecordUsage("zoho_update_fields", {
      updates: [{ zoho_id: "D1" }, { zoho_id: "D1" }, { zoho_id: "D2" }]
    }),
    2
  );
  assert.equal(
    taskOrderRecordUsage("zoho_get_record", {
      zoho_id: "D1",
      result: { id: "D1", Owner: { id: "U1" }, Account_Name: { id: "A1" }, Contact_Name: { id: "C1" } }
    }),
    0
  );
  assert.equal(
    taskOrderRecordUsage("zoho_api", {
      method: "GET",
      path: "/crm/v3/Deals/D1",
      result: { body: { data: [{ id: "D1" }] } }
    }),
    0
  );
  assert.equal(
    taskOrderRecordUsage("zoho_api", {
      method: "PUT",
      path: "/crm/v2.2/Deals",
      body: { data: [{ id: "D1" }, { id: "D1" }, { id: "D2" }] }
    }),
    2
  );
  assert.equal(
    taskOrderRecordUsage("zoho_api", {
      method: "POST",
      path: "/crm/v2.2/Tasks",
      body: { data: [{ Subject: "one" }, { Subject: "two" }] }
    }),
    2
  );
  assert.equal(taskOrderRecordUsage("browser_observe", { id: "nested-read-id" }), 0);
});

test("live record reads treat id as implicit instead of an unknown CRM field", () => {
  assert.deepEqual(normalizeZohoReadFields(["id", "Deal_Name", "Stage", "Deal_Name"]), ["Deal_Name", "Stage"]);
  assert.throws(() => normalizeZohoReadFields(["id", " ID "]), /besides implicit id/);
});

test("verified Tier-2 writes require live read-back before mirror sync", () => {
  assert.deepEqual(
    verifiedWriteFollowup({
      ok: true,
      snapshot: {
        tool_name: "zoho_update_fields",
        module: "Deals",
        updates: [
          {
            zoho_id: "D1",
            expected_name: "Test Deal",
            fields: { Next_Step: "3rd Email", Closing_Date: "2026-08-31" }
          }
        ]
      }
    }),
    {
      live_readback_required: true,
      mirror_sync_required: true,
      next_required_actions: [
        {
          tool: "zoho_api",
          reason: "Fetch the authoritative live Zoho record after the verified write.",
          method: "GET",
          paths: ["/crm/v3/Deals/D1"],
          params: { fields: "Deal_Name,Next_Step,Closing_Date" }
        },
        {
          tool: "db_sync_records",
          reason: "Upsert the exact live record(s) returned by zoho_get_record into the Supabase mirror.",
          module: "deals",
          records: "Use the exact authoritative live record object(s) returned by zoho_get_record; do not synthesize records."
        }
      ]
    }
  );
  assert.equal(
    verifiedWriteFollowup({
      ok: false,
      snapshot: { tool_name: "zoho_change_owner", module: "Contacts", owner: { id: "U1", name: "Aryan" }, records: [] }
    }),
    null
  );
});

test("approved task-order limits expand the agent loop without shrinking prior limits", () => {
  assert.deepEqual(
    expandedAgentLimits({
      currentMaxToolCalls: 60,
      currentTurnTimeoutMs: 900_000,
      orderBudget: { max_tool_calls: 200, max_wall_ms: 2_700_000, max_records_touched: 50 }
    }),
    { maxToolCalls: 200, turnTimeoutMs: 2_700_000 }
  );
  assert.deepEqual(
    expandedAgentLimits({
      currentMaxToolCalls: 250,
      currentTurnTimeoutMs: 3_000_000,
      orderBudget: { max_tool_calls: 200, max_wall_ms: 2_700_000, max_records_touched: 50 }
    }),
    { maxToolCalls: 250, turnTimeoutMs: 3_000_000 }
  );
});

test("task orders require batch records or explicit unattended intent", () => {
  const oneRecordChanges = [
    { record: "Deal 123", action: "recipient", detail: "Set To" },
    { record: "Deal 123", action: "subject", detail: "Set subject" },
    { record: "Deal 123", action: "body", detail: "Set body" }
  ];
  const batchChanges = ["1", "2", "3", "4"].map((record) => ({
    record: `Deal ${record}`,
    action: "email",
    detail: "Schedule email"
  }));

  assert.equal(taskOrderProposalDecision(oneRecordChanges, "Try now").allowed, false);
  assert.deepEqual(taskOrderProposalDecision(oneRecordChanges, "Run this in the background"), {
    allowed: true,
    reason: "unattended",
    recordCount: 1
  });
  assert.deepEqual(taskOrderProposalDecision(batchChanges, "Schedule these"), {
    allowed: true,
    reason: "batch",
    recordCount: 4
  });
  assert.deepEqual(taskOrderProposalDecision(oneRecordChanges, "Use the attached draft file"), {
    allowed: true,
    reason: "file_driven",
    recordCount: 1
  });
  assert.equal(defaultTaskOrderBudget(oneRecordChanges).max_records_touched, 2);
});

test("deterministic email contract keeps blank CC empty and requires safe schedule inputs", () => {
  const parsed = scheduleZohoEmailBatchSchema.parse({
    emails: [
      {
        reference: "Test email",
        contact_name: "Test",
        deal_name: "Test SAP ERP",
        subject: "Follow-up",
        body: "Hi Test,\n\nChecking in.",
        schedule_date: "2026-07-15",
        schedule_time: "10:00 AM",
        timezone: "Asia/Kolkata",
        preserve_signature: true,
        new_tasks: [{ subject: "Follow up", due_date: "2026-07-17" }],
        tasks_to_complete: [{ subject: "Prepare follow-up" }]
      }
    ]
  });
  assert.deepEqual(parsed.emails[0].cc, []);
  assert.equal(parsed.emails[0].preserve_signature, true);
  assert.deepEqual(parsed.emails[0].new_tasks, [{ subject: "Follow up", due_date: "2026-07-17" }]);
  assert.deepEqual(parsed.emails[0].tasks_to_complete, [{ subject: "Prepare follow-up" }]);
  assert.equal(isEmailSchedulingExtensionJob("schedule_zoho_email"), true);
  assert.equal(isEmailSchedulingExtensionJob("browser_eval"), false);

  assert.throws(
    () =>
      scheduleZohoEmailBatchSchema.parse({
        emails: [
          {
            reference: "Bad schedule",
            contact_name: "Test",
            subject: "Follow-up",
            body: "Body",
            schedule_date: "07/15/2026",
            schedule_time: "tomorrow",
            preserve_signature: true
          }
        ]
      }),
    /YYYY-MM-DD|HH:MM/
  );
  assert.throws(() =>
    scheduleZohoEmailBatchSchema.parse({
      emails: [
        {
          reference: "Unsafe signature",
          contact_name: "Test",
          subject: "Follow-up",
          body: "Body",
          schedule_date: "2026-07-15",
          schedule_time: "10:00 AM",
          preserve_signature: false
        }
      ]
    })
  );
  assert.throws(() =>
    scheduleZohoEmailBatchSchema.parse({
      emails: [
        {
          reference: "Bad task date",
          contact_name: "Test",
          subject: "Follow-up",
          body: "Body",
          schedule_date: "2026-07-15",
          schedule_time: "10:00 AM",
          preserve_signature: true,
          new_tasks: [{ subject: "Follow up", due_date: "next Friday" }]
        }
      ]
    })
  );
});

test("task preparation failures block model-driven scheduling recovery", () => {
  const failure = {
    status: "failed",
    records: [
      {
        result: {
          status: "failed",
          result: { error_code: "TASK_PREPARATION_FAILED", result: { timings_ms: { prepare_tasks: 1303 } } }
        }
      }
    ]
  };
  assert.equal(hasTaskPreparationFailure(failure), true);
  assert.equal(hasTaskPreparationFailure({ error_code: "COMPOSER_OPEN_FAILED" }), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("browser_eval", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("browser_observe", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("browser_navigate", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("browser_screenshot", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("browser_input", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("zoho_read_api", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("zoho_api", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("schedule_zoho_email_batch", true), false);
  assert.equal(allowsToolAfterTaskPreparationFailure("complete_task_order", true), true);
});

test("browser primitives validate navigation and input shapes", () => {
  assert.equal(
    validateBrowserToolCall({
      id: "nav",
      name: "browser_navigate",
      args: { url: "https://crm.zoho.com/crm/org890324941/tab/Potentials/123" }
    }).name,
    "browser_navigate"
  );
  assert.throws(
    () =>
      validateBrowserToolCall({
        id: "nav",
        name: "browser_navigate",
        args: { url: "https://example.com/" }
      }),
    /crm\.zoho\.com/
  );
  assert.equal(
    validateBrowserToolCall({
      id: "input",
      name: "browser_input",
      args: { action: "type", selector: "#ceToAddr_1", value: "test@example.com", press_enter: true }
    }).name,
    "browser_input"
  );
  assert.throws(
    () => validateBrowserToolCall({ id: "input", name: "browser_input", args: { action: "click" } }),
    /requires selector or text/
  );
});

test("composer browser gate requires approval for composer-changing tools", () => {
  assert.equal(browserEvalIsProvablyReadOnly("return document.querySelector('#ceSubject_1')?.value ?? ''"), true);
  assert.equal(browserEvalIsProvablyReadOnly("document.querySelector('#ceSubject_1').value = 'x'; return {}"), false);
  assert.deepEqual(
    composerBrowserGateDecision({
      toolName: "browser_input",
      composerDetected: true,
      approvalId: null,
      taskOrderId: null
    }),
    {
      allowed: false,
      reason: "composer input requires an approved task order or approval; propose a task order first"
    }
  );
  assert.equal(
    composerBrowserGateDecision({
      toolName: "browser_input",
      composerDetected: true,
      taskOrderId: "order-1"
    }).allowed,
    true
  );
  assert.equal(
    composerBrowserGateDecision({
      toolName: "browser_eval",
      args: { code: "return document.body.innerText" },
      composerDetected: true
    }).allowed,
    true
  );
  assert.equal(
    composerBrowserGateDecision({
      toolName: "browser_eval",
      args: { code: "document.querySelector('#ceToAddr_1').dispatchEvent(new Event('input'))" },
      composerDetected: true
    }).allowed,
    false
  );
  assert.equal(
    composerBrowserGateDecision({
      toolName: "browser_input",
      composerDetected: false
    }).allowed,
    true
  );
});

test("scheduled email completion flags missing Scheduled read-back after composer browser writes", () => {
  assert.deepEqual(
    extractScheduledEmailVerification({
      result: {
        scheduled_email: {
          status: "Scheduled",
          recipient: "test@example.com",
          subject: "Cloud ERP follow-up",
          date: "2026-07-15",
          time: "10:00 AM"
        }
      }
    }),
    {
      recipient: "test@example.com",
      subject: "Cloud ERP follow-up",
      date: "2026-07-15",
      time: "10:00 AM"
    }
  );
  assert.deepEqual(
    extractScheduledEmailVerification({
      body: {
        data: [
          {
            Status: "Scheduled",
            To_Email: "test@example.com",
            Subject: "Cloud ERP follow-up",
            Scheduled_Date: "2026-07-15",
            Scheduled_Time: "10:00 AM"
          }
        ]
      }
    }),
    {
      recipient: "test@example.com",
      subject: "Cloud ERP follow-up",
      date: "2026-07-15",
      time: "10:00 AM"
    }
  );
  assert.equal(
    extractScheduledEmailVerification({
      scheduled_email: { status: "Scheduled", recipient: "test@example.com", subject: "Missing time", date: "2026-07-15" }
    }),
    null
  );
  assert.equal(
    hasComposerBrowserMutation({
      task_order_id: "order-1",
      composer_gate: { composer_detected: true, state_changing: true }
    }),
    true
  );
  assert.deepEqual(
    scheduledEmailCompletionDecision({ scope: "write", composerMutations: 1, scheduledVerifications: 0 }),
    {
      ok: true,
      scheduled_email_verification_missing: true
    }
  );
  assert.deepEqual(
    scheduledEmailCompletionDecision({ scope: "write", composerMutations: 1, scheduledVerifications: 1 }),
    { ok: true, scheduled_email_verification_missing: false }
  );
  assert.deepEqual(
    scheduledEmailCompletionDecision({ scope: "read", composerMutations: 1, scheduledVerifications: 0 }),
    { ok: true, scheduled_email_verification_missing: false }
  );
});

test("ui_step validation and teach-mode gate are strict", () => {
  assert.deepEqual(uiStepTeachModeDecision(true), { allowed: true, reason: "teach_mode" });
  assert.deepEqual(uiStepTeachModeDecision(false), { allowed: false, reason: "ui_step requires teach mode" });

  const validated = validateUiToolCall({
    id: "call-ui-1",
    name: "ui_step",
    args: { step: { type: "wait_for", selector: "#task_subject", timeout_ms: 10000 } }
  });
  assert.deepEqual(validated.args, { step: { type: "wait_for", selector: "#task_subject", timeout_ms: 10000 } });

  assert.throws(
    () =>
      validateUiToolCall({
        id: "call-ui-2",
        name: "ui_step",
        args: { step: { type: "wait_for", selector: "#x", text: "x" } }
      }),
    /exactly one/
  );
  assert.throws(
    () =>
      validateUiToolCall({
        id: "call-ui-3",
        name: "ui_step",
        args: { step: { type: "open_url", url: "https://example.com/" } }
      }),
    /crm\.zoho\.com/
  );
});

test("save_ui_workflow validation preserves read/write and selector safety", () => {
  const readWorkflow = prepareUiWorkflow({
    name: "Read Next Step",
    description: "Read the Next Step field from a deal.",
    effect: "read",
    params: [{ name: "deal_id", description: "Zoho deal id", example: "123456789" }],
    steps: [
      { type: "open_url", url: "https://crm.zoho.com/crm/org890324941/tab/Potentials/{deal_id}" },
      { type: "wait_for", text: "Next Step" },
      { type: "read_field", selector: "input[name='Next_Step']" }
    ]
  });
  assert.equal(readWorkflow.effect, "read");

  assert.throws(
    () =>
      prepareUiWorkflow({
        name: "Complete Task",
        effect: "read",
        steps: [{ type: "click", text: "Mark as Completed" }]
      }),
    /must be saved with effect='write'/
  );

  assert.throws(
    () =>
      prepareUiWorkflow({
        name: "Bad Selector",
        effect: "read",
        steps: [{ type: "read_field", selector: "input[name='{field_name}']" }]
      }),
    /params cannot be used in selectors/
  );
  assert.throws(
    () =>
      prepareUiWorkflow({
        name: "Bad Frame Selector",
        effect: "read",
        steps: [{ type: "fill_field", frame_selector: "#{composer_frame}", selector: "#editorDiv", value: "Hello" }]
      }),
    /params cannot be used in selectors/
  );
});

test("workflow edits re-derive write effect from mutating steps", () => {
  assert.equal(
    workflowEffectForSteps([
      { type: "open_url", url: "https://crm.zoho.com/crm/org890324941/tab/Potentials/123" },
      { type: "confirm_text_present", text: "Next Step" },
      { type: "read_field", selector: "input[name='Next_Step']" }
    ]),
    "read"
  );
  assert.equal(
    workflowEffectForSteps([
      { type: "open_url", url: "https://crm.zoho.com/crm/org890324941/tab/Potentials/123" },
      { type: "fill_field", selector: "input[name='Next_Step']", value: "Call" }
    ]),
    "write"
  );
});

test("run_ui_workflow replay substitutes only safe slots", () => {
  const replay = prepareUiWorkflowReplay(
    {
      name: "Read Deal Next Step",
      description: "Open a deal and read Next Step.",
      effect: "read",
      trusted: false,
      version: 1,
      params: [{ name: "deal_id", description: "Zoho deal id", example: "123456789" }],
      steps: [
        { type: "open_url", url: "https://crm.zoho.com/crm/org890324941/tab/Potentials/{deal_id}" },
        { type: "confirm_text_present", text: "Next Step" },
        { type: "read_field", selector: "input[name='Next_Step']" }
      ]
    },
    { name: "Read Deal Next Step", params: { deal_id: "987654321" } }
  );

  assert.equal(replay.effect, "read");
  assert.equal(replay.steps[0].type, "open_url");
  assert.deepEqual(replay.steps[0], {
    type: "open_url",
    url: "https://crm.zoho.com/crm/org890324941/tab/Potentials/987654321"
  });

  assert.throws(
    () =>
      prepareUiWorkflowReplay(
        {
          name: "Read Deal Next Step",
          effect: "read",
          trusted: false,
          version: 1,
          params: [{ name: "deal_id", description: "Zoho deal id", example: "123456789" }],
          steps: [{ type: "open_url", url: "https://crm.zoho.com/crm/org890324941/tab/Potentials/{deal_id}" }]
        },
        { name: "Read Deal Next Step", params: {} }
      ),
    /Missing workflow param/
  );

  assert.throws(
    () =>
      prepareUiWorkflowReplay(
        {
          name: "Open Host",
          effect: "read",
          trusted: false,
          version: 1,
          params: [{ name: "host", description: "Host", example: "example.com" }],
          steps: [{ type: "open_url", url: "https://{host}/" }]
        },
        { name: "Open Host", params: { host: "example.com" } }
      ),
    /crm\.zoho\.com/
  );
});

test("run_ui_workflow preserves write-effect classification for mutating steps", () => {
  const replay = prepareUiWorkflowReplay(
    {
      name: "Complete Task",
      effect: "write",
      trusted: false,
      version: 2,
      params: [{ name: "status", description: "Task status", example: "Completed" }],
      steps: [
        { type: "click", text: "Status" },
        { type: "fill_field", selector: "input[name='Status']", value: "{status}", press_enter: true }
      ]
    },
    { name: "Complete Task", params: { status: "Completed" } }
  );

  assert.equal(replay.effect, "write");
  assert.deepEqual(replay.steps[1], {
    type: "fill_field",
    selector: "input[name='Status']",
    value: "Completed",
    press_enter: true
  });
});
