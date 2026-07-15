import { clsx } from "clsx";

const statusClasses: Record<string, string> = {
  connected: "border-success/40 bg-success/10 text-success",
  ready: "border-success/40 bg-success/10 text-success",
  completed: "border-success/40 bg-success/10 text-success",
  success: "border-success/40 bg-success/10 text-success",
  running: "border-running/40 bg-running/10 text-running",
  preview_ready: "border-running/40 bg-running/10 text-running",
  draft: "border-line bg-surface text-muted",
  pending: "border-pending/40 bg-pending/10 text-pending",
  paused: "border-pending/40 bg-pending/10 text-pending",
  failed: "border-danger/40 bg-danger/10 text-danger",
  error: "border-danger/40 bg-danger/10 text-danger",
  cancelled: "border-idle/40 bg-idle/10 text-muted",
  canceled: "border-idle/40 bg-idle/10 text-muted",
  missing: "border-danger/40 bg-danger/10 text-danger",
  disconnected: "border-danger/40 bg-danger/10 text-danger",
  skipped: "border-idle/40 bg-idle/10 text-muted",
  needs_review: "border-accent/40 bg-accent/10 text-accent"
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium capitalize",
        statusClasses[status] ?? "border-line bg-surface text-muted"
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}



