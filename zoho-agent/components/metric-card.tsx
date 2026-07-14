import type { LucideIcon } from "lucide-react";

export function MetricCard({
  label,
  value,
  icon: Icon,
  note
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted">{label}</div>
        <Icon className="h-4 w-4 text-accent" aria-hidden="true" />
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-[0]">{value}</div>
      {note ? <div className="mt-2 text-xs text-muted">{note}</div> : null}
    </div>
  );
}

