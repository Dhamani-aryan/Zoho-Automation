export type ScheduledEmailVerification = {
  recipient: string;
  subject: string;
  date: string;
  time: string;
};

export const SCHEDULED_EMAIL_READBACK_REQUIRED =
  "Composer scheduling orders should read back the Scheduled tab; if missing, flag it and continue.";

function stringField(row: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function scheduledStatus(row: Record<string, unknown>) {
  const status = stringField(row, ["status", "Status", "state", "State"]);
  return status.toLowerCase() === "scheduled" || row.scheduled_found === true || row.row_found === true || row.scheduled === true;
}

function verificationFromRow(row: Record<string, unknown>): ScheduledEmailVerification | null {
  if (!scheduledStatus(row)) return null;
  const recipient = stringField(row, ["recipient", "Recipient", "to", "to_email", "email", "To", "To_Email", "Email"]);
  const subject = stringField(row, ["subject", "Subject"]);
  const date = stringField(row, ["date", "schedule_date", "scheduled_date", "Scheduled_Date", "Scheduled Date"]);
  const time = stringField(row, ["time", "schedule_time", "scheduled_time", "Scheduled_Time", "Scheduled Time"]);
  return recipient && subject && date && time ? { recipient, subject, date, time } : null;
}

export function extractScheduledEmailVerification(value: unknown): ScheduledEmailVerification | null {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      const match = verificationFromRow(current as Record<string, unknown>);
      if (match) return match;
    }
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return null;
}

export function hasComposerBrowserMutation(value: unknown) {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      const gate = record.composer_gate;
      if (gate && typeof gate === "object") {
        const gateRecord = gate as Record<string, unknown>;
        if (gateRecord.composer_detected === true && gateRecord.state_changing === true) return true;
      }
    }
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return false;
}

export function scheduledEmailCompletionDecision(input: {
  scope: "read" | "write";
  composerMutations: number;
  scheduledVerifications: number;
}) {
  return {
    ok: true as const,
    scheduled_email_verification_missing:
      input.scope === "write" && input.composerMutations > 0 && input.scheduledVerifications === 0
  };
}
