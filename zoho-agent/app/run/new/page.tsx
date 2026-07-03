import { ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";

const presets = [
  {
    name: "Update Deal Next Step",
    mode: "API",
    state: "First executor",
    details: "The first live block planned for Phase 3. Reads before, updates, then verifies."
  },
  {
    name: "KD Blitz",
    mode: "UI plus API",
    state: "Phase 4",
    details: "Task create, task complete, Next Step update, and scheduled email per contact."
  },
  {
    name: "Assign book of business",
    mode: "API",
    state: "Phase 3",
    details: "Accounts, Contacts, and Deals owner change with explicit cascade behavior."
  },
  {
    name: "Read-only contact list",
    mode: "API",
    state: "Phase 3",
    details: "Skips approval gate, still logs report output and ambiguous matches."
  }
];

export default function NewRunPage() {
  return (
    <AppShell>
      <PageHeader
        eyebrow="Run setup"
        title="New workflow run"
        description="Phase 1 shows the planned workflow catalog. Live validation and execution are added after parser and extension work."
      />
      <div className="grid gap-4 xl:grid-cols-2">
        {presets.map((preset) => (
          <article key={preset.name} className="rounded-md border border-line bg-white p-4 shadow-soft">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">{preset.name}</h2>
                <p className="mt-2 text-sm leading-6 text-muted">{preset.details}</p>
              </div>
              <span className="rounded-md border border-line bg-surface px-2 py-1 text-xs">
                {preset.mode}
              </span>
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs text-muted">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />
              {preset.state}
            </div>
          </article>
        ))}
      </div>
      <section className="mt-6 rounded-md border border-line bg-white p-4 shadow-soft">
        <h2 className="text-sm font-semibold">Approval rules</h2>
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-md border border-line bg-surface p-3">
            Write runs require preview and approval.
          </div>
          <div className="rounded-md border border-line bg-surface p-3">
            Read-only runs skip approval and still produce reports.
          </div>
          <div className="rounded-md border border-line bg-surface p-3">
            Bulk Stage edits are admin-only in v1.
          </div>
        </div>
      </section>
    </AppShell>
  );
}
