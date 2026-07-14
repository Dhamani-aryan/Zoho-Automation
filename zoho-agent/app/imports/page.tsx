import { AppShell } from "@/components/app-shell";
import { ImportPreviewer } from "@/components/import-previewer";
import { PageHeader } from "@/components/page-header";

export default function ImportsPage() {
  return (
    <AppShell>
      <PageHeader
        eyebrow="Imports"
        title="File import preview"
        description="Preview link CSVs, contact lists, and Markdown drafts before they are mapped into the database or parser tests."
      />
      <ImportPreviewer />
      <section className="mt-6 rounded-md border border-line bg-surface p-4 text-sm leading-6 text-muted ">
        CSV import into the database will use this preview flow: upload, map columns, validate,
        then insert. The live insert step is intentionally separate so no file silently becomes
        operational data.
      </section>
    </AppShell>
  );
}

