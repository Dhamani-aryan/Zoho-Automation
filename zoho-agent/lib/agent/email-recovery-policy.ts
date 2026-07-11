const BLOCKED_AFTER_TASK_PREPARATION_FAILURE = new Set([
  "schedule_zoho_email_batch",
  "zoho_search",
  "zoho_get_record",
  "zoho_get_related",
  "zoho_read_api",
  "browser_observe",
  "browser_eval",
  "ui_step",
  "run_ui_workflow"
]);

export function hasTaskPreparationFailure(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current) && (current as { error_code?: unknown }).error_code === "TASK_PREPARATION_FAILED") {
      return true;
    }
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return false;
}

export function allowsToolAfterTaskPreparationFailure(toolName: string, failureActive: boolean) {
  return !failureActive || !BLOCKED_AFTER_TASK_PREPARATION_FAILURE.has(toolName);
}
