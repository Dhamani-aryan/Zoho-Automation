# Honest review and differences: Zoho CRM agent vs HeySnap-style autonomy

Date: 2026-07-12
Input reviewed: PROJECT_BRIEF_FOR_HEYSNAP.md and the live-run notes through Phase H.

## Executive view

The architecture has moved in the right direction: the model now has general live primitives
and skill-guide knowledge instead of a task-specific deterministic email pipeline. The next
problem is not "more gates"; it is too many blocking gates for work that is reversible or
observable. The system should keep structural guardrails, keep records, and remove most
permission pauses.

## What is still workflow-first in disguise

- Completion refusal based on verification receipts turns verification into a gate. A receipt
  mismatch should be a flagged result, not a hard stop, unless the action would cross a
  catastrophic guardrail such as send-now, delete, wrong org, or wrong module.
- Per-write approvals and task-order approvals slow down exactly the work the agent is meant
  to perform unattended. They also train the model to stop and ask instead of adopting the
  current state and continuing.
- Saved UI workflow execution is a second workflow engine. Teach mode is useful, but the
  durable output should be a skill guide that the model can adapt, not a replay button the
  model calls blindly.
- One-read-per-record receipt verification wastes calls. Batch read-backs by module and id
  should be the default.

## Recommended distinction: guardrails, records, gates

Guardrails are structural and cheap. They should never be bypassed:

- no CRM deletes;
- schedule email, never send immediately;
- org/module/path allowlist;
- crm.zoho.com-only browser navigation;
- extension-side refusal of forged or unsupported write jobs;
- signature preservation.

Records are always-on and non-blocking:

- before-value change log;
- read-back receipts;
- audit events;
- tool/job transcripts;
- undo entries.

Gates block work and should be rare:

- keep one email sample approval for a batch because a bad template repeats across many
  recipients and scheduled email reversal is operationally different from field undo;
- remove per-write approvals for Deals, Contacts, Accounts, and Tasks once the change log
  and undo path exist.

## Composer differences and gotchas

- Recipient chips must be reconciled by the chip email attribute, not visible label text.
- Pre-filled correct To chips should be adopted, not removed and retyped.
- After Enter, wait out Loading/pending chips before judging.
- If autocomplete hijacks Enter into the wrong committed chip, remove that chip, dismiss the
  dropdown with Escape, and retry.
- Duplicate chips with the same email are a cleanup task, not an ambiguity.
- Red or invalid chips are failure evidence, never success.
- Cc/Bcc inputs only exist after reveal.
- Touching the composer may autosave a Draft; drafts are not proof of scheduling.

## Send guard review

The hard send guard is worth keeping. The main refinements are:

- classify send controls by exact accessible name / role / aria attributes, not substring
  matching;
- keep the elementFromPoint check at dispatch time;
- block plain Enter if focus is currently on or inside a send control;
- avoid false positives for controls like "Resend" or "Send test" unless their accessible
  role/name is the primary send action.

## Economy recommendations

- One browser_eval read should gather the full local state needed for the next few decisions:
  chips with email attributes, leftover inputs, subject value, body/signature state, visible
  schedule controls, and relevant rects.
- Commitments should still be serialized: chip Enter, Schedule click, Schedule & Close each
  need their own read-back.
- Resolve record sets in bulk: one mirror search/query per module, then one live read-back
  batch where possible.
- For the one-email/two-task acceptance case, a healthy agent-first run should target roughly
  10-14 tool calls.

## Phase I direction

The recommended next phase is:

1. Rewrite the soul prompt around autonomy, guardrails, records-not-gates, adopt-dont-recreate,
   verify-by-identity, and call economy.
2. Fix the send guard false-positive and focused-Enter gaps.
3. Make receipts non-blocking and batched.
4. Add universal change logging and undo before removing gates.
5. Remove per-write approval gates for reversible CRM writes.
6. Retire model-facing run_ui_workflow in favor of skill guide distillation.
7. Add WebSocket push transport while keeping polling fallback.
8. Delete the old deterministic pipeline and obsolete grep proofs.

