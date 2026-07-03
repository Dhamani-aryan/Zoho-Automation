import { clsx } from "clsx";

const statusClasses: Record<string, string> = {
  connected: "border-emerald-200 bg-emerald-50 text-emerald-800",
  ready: "border-emerald-200 bg-emerald-50 text-emerald-800",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  running: "border-amber-200 bg-amber-50 text-amber-800",
  preview_ready: "border-sky-200 bg-sky-50 text-sky-800",
  draft: "border-line bg-white text-muted",
  paused: "border-amber-200 bg-amber-50 text-amber-800",
  failed: "border-red-200 bg-red-50 text-red-700",
  missing: "border-red-200 bg-red-50 text-red-700",
  disconnected: "border-red-200 bg-red-50 text-red-700",
  skipped: "border-zinc-200 bg-zinc-50 text-zinc-700",
  needs_review: "border-purple-200 bg-purple-50 text-purple-800"
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium capitalize",
        statusClasses[status] ?? "border-line bg-white text-muted"
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
