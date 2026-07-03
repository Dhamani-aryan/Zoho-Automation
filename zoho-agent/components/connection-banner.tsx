import { StatusBadge } from "@/components/status-badge";

export function ConnectionBanner({ connected }: { connected: boolean }) {
  return (
    <div className="mb-6 rounded-md border border-line bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold">Supabase connection</div>
          <div className="mt-1 text-sm text-muted">
            {connected
              ? "Server environment values are present. Screens will read from Supabase."
              : "Environment values are not filled yet. The app is running in empty local shell mode."}
          </div>
        </div>
        <StatusBadge status={connected ? "connected" : "disconnected"} />
      </div>
    </div>
  );
}
