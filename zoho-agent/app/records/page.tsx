import Link from "next/link";
import { ExternalLink, Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { RECORD_MODULES, type RecordModuleKey } from "@/lib/constants";
import { listRecords } from "@/lib/supabase/queries";

export const dynamic = "force-dynamic";

type RecordsPageProps = {
  searchParams?: Promise<{
    module?: string;
    q?: string;
  }>;
};

function parseModule(value: string | undefined): RecordModuleKey {
  if (value === "contacts" || value === "deals" || value === "accounts") return value;
  return "accounts";
}

export default async function RecordsPage({ searchParams }: RecordsPageProps) {
  const params = (await searchParams) ?? {};
  const moduleKey = parseModule(params.module);
  const search = params.q ?? "";
  const rows = await listRecords(moduleKey, search);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Database"
        title="Records browser"
        description="Browse imported Accounts, Contacts, and Deals. Phase 1 import CSVs populate these tables."
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(RECORD_MODULES) as RecordModuleKey[]).map((key) => (
            <Link
              key={key}
              href={`/records?module=${key}`}
              className={`rounded-md border px-3 py-2 text-sm ${
                key === moduleKey
                  ? "border-accent bg-success/10 text-accent"
                  : "border-line bg-surface text-ink"
              }`}
            >
              {RECORD_MODULES[key].label}
            </Link>
          ))}
        </div>
        <form className="flex w-full gap-2 lg:w-96">
          <input type="hidden" name="module" value={moduleKey} />
          <label className="sr-only" htmlFor="q">
            Search
          </label>
          <input
            id="q"
            name="q"
            defaultValue={search}
            className="focus-ring h-10 flex-1 rounded-md border border-line bg-surface px-3 text-sm"
            placeholder={`Search ${RECORD_MODULES[moduleKey].label.toLowerCase()}`}
          />
          <button
            className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md border border-line bg-surface"
            type="submit"
            aria-label="Search records"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
      </div>

      <section className="overflow-hidden rounded-md border border-line bg-surface ">
        <div className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-surface text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Zoho ID</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Detail</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">Link</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-3 font-medium">{row.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.zoho_id ?? ""}</td>
                  <td className="px-4 py-3">{row.owner ?? ""}</td>
                  <td className="max-w-64 truncate px-4 py-3 text-muted">{row.extra ?? ""}</td>
                  <td className="px-4 py-3 text-muted">
                    {row.updated_at ? new Date(row.updated_at).toLocaleDateString() : ""}
                  </td>
                  <td className="px-4 py-3">
                    {row.zoho_url ? (
                      <a
                        href={row.zoho_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line"
                        aria-label={`Open ${row.name} in Zoho`}
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? (
          <div className="border-t border-line px-4 py-10 text-sm text-muted">
            No records found. Import the link CSVs when they are ready.
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

