import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { RunCommandBuilder } from "@/components/run-command-builder";

export const dynamic = "force-dynamic";

export default function NewRunPage() {
  return (
    <AppShell>
      <PageHeader
        eyebrow="Run setup"
        title="New workflow run"
        description="Parse a command, validate records, and save a preview run. Phase 2 stops before Zoho execution."
      />
      <RunCommandBuilder />
    </AppShell>
  );
}
