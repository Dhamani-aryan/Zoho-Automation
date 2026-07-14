import { AppShell } from "@/components/app-shell";
import { FieldMetaImporter } from "@/components/field-meta-importer";
import { PageHeader } from "@/components/page-header";

export default function FieldMetaPage() {
  return (
    <AppShell>
      <PageHeader
        eyebrow="Admin"
        title="Field metadata import"
        description="Paste Zoho settings/fields JSON for Accounts, Contacts, Deals, or Tasks. The validator uses this for API names, data types, and picklists."
      />
      <FieldMetaImporter />
    </AppShell>
  );
}

