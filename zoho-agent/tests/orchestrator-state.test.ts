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
import { responsesInputFromMessages } from "../lib/llm/tool-calls";
import { routeCoreSkillGuides } from "../lib/agent/guide-routing";
import {
  readWorkspaceTextFile,
  resolveWorkspaceFilePath,
  workspaceRootFromCwd
} from "../lib/agent/workspace-files";
import { normalizeZohoReadFields } from "../lib/agent/zoho-read-fields";
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

test("live record reads treat id as implicit instead of an unknown CRM field", () => {
  assert.deepEqual(normalizeZohoReadFields(["id", "Deal_Name", "Stage", "Deal_Name"]), ["Deal_Name", "Stage"]);
  assert.throws(() => normalizeZohoReadFields(["id", " ID "]), /besides implicit id/);
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

test("composer browser gate helper is non-blocking in V3", () => {
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
      allowed: true,
      reason: "composer_tools_ungated"
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
    true
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

