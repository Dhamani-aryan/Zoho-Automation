import test from "node:test";
import assert from "node:assert/strict";
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
  taskOrderBudgetDecision,
  taskOrderProposalDecision
} from "../lib/agent/task-orders";
import { responsesInputFromMessages } from "../lib/llm/tool-calls";
import { routeCoreSkillGuides } from "../lib/agent/guide-routing";

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
  assert.equal(defaultTaskOrderBudget(oneRecordChanges).max_records_touched, 2);
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
