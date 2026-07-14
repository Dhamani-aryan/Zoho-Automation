"use client";

import { useState } from "react";
import { FileUp, Loader2 } from "lucide-react";

type PreviewResult = {
  fileName: string;
  fileType: "csv" | "markdown" | "text";
  rowCount: number;
  columns: string[];
  rows: Record<string, string>[];
  sections?: string[];
  warnings: string[];
};

const moduleFields = {
  accounts: [
    { key: "account_name", label: "Account name", required: true, guesses: ["account", "account name", "company"] },
    { key: "zoho_url", label: "Zoho URL", required: false, guesses: ["zoho url", "account url", "url", "link"] },
    { key: "zoho_account_id", label: "Zoho account ID", required: false, guesses: ["account id", "zoho account id"] },
    { key: "website", label: "Website", required: false, guesses: ["website", "site"] },
    { key: "phone", label: "Phone", required: false, guesses: ["phone"] },
    { key: "industry", label: "Industry", required: false, guesses: ["industry"] },
    { key: "owner", label: "Owner", required: false, guesses: ["owner"] }
  ],
  contacts: [
    { key: "full_name", label: "Full name", required: true, guesses: ["full name", "contact", "contact name", "name"] },
    { key: "first_name", label: "First name", required: false, guesses: ["first name", "firstname"] },
    { key: "last_name", label: "Last name", required: false, guesses: ["last name", "lastname"] },
    { key: "email", label: "Email", required: false, guesses: ["email", "email address"] },
    { key: "zoho_url", label: "Zoho URL", required: false, guesses: ["zoho url", "contact url", "url", "link"] },
    { key: "zoho_contact_id", label: "Zoho contact ID", required: false, guesses: ["contact id", "zoho contact id"] },
    { key: "title", label: "Title", required: false, guesses: ["title", "job title"] },
    { key: "phone", label: "Phone", required: false, guesses: ["phone"] },
    { key: "mobile", label: "Mobile", required: false, guesses: ["mobile", "cell"] },
    { key: "owner", label: "Owner", required: false, guesses: ["owner"] }
  ],
  deals: [
    { key: "deal_name", label: "Deal name", required: true, guesses: ["deal", "deal name", "potential", "opportunity"] },
    { key: "zoho_url", label: "Zoho URL", required: false, guesses: ["zoho url", "deal url", "potential url", "url", "link"] },
    { key: "zoho_deal_id", label: "Zoho deal ID", required: false, guesses: ["deal id", "zoho deal id", "potential id"] },
    { key: "stage", label: "Stage", required: false, guesses: ["stage"] },
    { key: "next_step", label: "Next Step", required: false, guesses: ["next step", "next_step"] },
    { key: "owner", label: "Owner", required: false, guesses: ["owner"] },
    { key: "closing_date", label: "Closing date", required: false, guesses: ["closing date", "close date"] },
    { key: "amount", label: "Amount", required: false, guesses: ["amount", "value"] }
  ]
} as const;

type ImportModule = keyof typeof moduleFields;

type ImportResult = {
  stored: boolean;
  module: string;
  parsedRows: number;
  importableRows: number;
  storedRows: number;
  skippedRows: number;
  warnings?: string[];
  warning?: string;
};

function guessMapping(columns: string[], module: ImportModule) {
  const mapping: Record<string, string> = {};
  const normalized = columns.map((column) => ({
    original: column,
    key: column.toLowerCase().replace(/[_-]/g, " ").trim()
  }));

  for (const field of moduleFields[module]) {
    const match = normalized.find((column) =>
      field.guesses.some((guess) => column.key === guess || column.key.includes(guess))
    );
    if (match) mapping[field.key] = match.original;
  }

  return mapping;
}

export function ImportPreviewer() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [targetModule, setTargetModule] = useState<ImportModule>("accounts");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  async function preview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setImportResult(null);

    if (!file) {
      setError("Choose a CSV or Markdown file first.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    setLoading(true);

    const response = await fetch("/api/imports/preview", {
      method: "POST",
      body: formData
    });

    const payload = await response.json();
    setLoading(false);

    if (!response.ok) {
      setError(payload.error ?? "Preview failed.");
      return;
    }

    setResult(payload);
    setMapping(guessMapping(payload.columns ?? [], targetModule));
  }

  async function importRecords() {
    setError(null);
    setImportResult(null);

    if (!file || !result) {
      setError("Preview a CSV file before importing.");
      return;
    }

    if (result.fileType !== "csv" && result.fileType !== "text") {
      setError("Only delimited files can be imported into record tables.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("module", targetModule);
    formData.append("mapping", JSON.stringify(mapping));

    setImporting(true);
    const response = await fetch("/api/imports/records", {
      method: "POST",
      body: formData
    });

    const payload = await response.json();
    setImporting(false);

    if (!response.ok) {
      setError(payload.error ?? "Import failed.");
      return;
    }

    setImportResult(payload);
  }

  return (
    <div className="rounded-md border border-line bg-surface p-4 ">
      <form onSubmit={preview} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="text-sm font-medium">File</span>
          <input
            className="focus-ring mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            type="file"
            accept=".csv,.tsv,.md,.markdown,.txt"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileUp className="h-4 w-4" aria-hidden="true" />
          )}
          Preview
        </button>
      </form>

      {error ? (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-line bg-surface p-3">
              <div className="text-xs text-muted">File</div>
              <div className="mt-1 truncate text-sm font-semibold">{result.fileName}</div>
            </div>
            <div className="rounded-md border border-line bg-surface p-3">
              <div className="text-xs text-muted">Type</div>
              <div className="mt-1 text-sm font-semibold uppercase">{result.fileType}</div>
            </div>
            <div className="rounded-md border border-line bg-surface p-3">
              <div className="text-xs text-muted">Rows or sections</div>
              <div className="mt-1 text-sm font-semibold">{result.rowCount}</div>
            </div>
          </div>

          {result.warnings.length > 0 ? (
            <div className="rounded-md border border-pending/40 bg-pending/10 px-3 py-2 text-sm text-pending">
              {result.warnings.join(" ")}
            </div>
          ) : null}

          {result.sections?.length ? (
            <div>
              <div className="mb-2 text-sm font-semibold">Markdown sections</div>
              <div className="max-h-64 overflow-auto rounded-md border border-line">
                {result.sections.map((section) => (
                  <div key={section} className="border-b border-line px-3 py-2 text-sm last:border-b-0">
                    {section}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {result.rows.length > 0 ? (
          <div className="overflow-auto rounded-md border border-line">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-surface text-xs uppercase text-muted">
                  <tr>
                    {result.columns.map((column) => (
                      <th key={column} className="whitespace-nowrap px-3 py-2 font-semibold">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index} className="border-t border-line">
                      {result.columns.map((column) => (
                        <td key={column} className="max-w-64 truncate px-3 py-2">
                          {row[column]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {result.fileType === "csv" || result.fileType === "text" ? (
            <div className="rounded-md border border-line bg-surface p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold">Map and import records</div>
                  <div className="mt-1 text-sm text-muted">
                    Choose the target table and map only the columns you trust.
                  </div>
                </div>
                <select
                  className="focus-ring h-10 rounded-md border border-line bg-surface px-3 text-sm"
                  value={targetModule}
                  onChange={(event) => {
                    const nextModule = event.target.value as ImportModule;
                    setTargetModule(nextModule);
                    setMapping(guessMapping(result.columns, nextModule));
                    setImportResult(null);
                  }}
                >
                  <option value="accounts">Accounts</option>
                  <option value="contacts">Contacts</option>
                  <option value="deals">Deals</option>
                </select>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {moduleFields[targetModule].map((field) => (
                  <label key={field.key} className="block">
                    <span className="text-xs font-medium">
                      {field.label}
                      {field.required ? " *" : ""}
                    </span>
                    <select
                      className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-surface px-3 text-sm"
                      value={mapping[field.key] ?? ""}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [field.key]: event.target.value
                        }))
                      }
                    >
                      <option value="">Not mapped</option>
                      {result.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <button
                type="button"
                onClick={importRecords}
                disabled={importing}
                className="focus-ring mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Import mapped records
              </button>

              {importResult ? (
                <div className="mt-4 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
                  {importResult.stored ? "Stored" : "Validated"} {importResult.importableRows}{" "}
                  {importResult.module} rows. Skipped {importResult.skippedRows}.{" "}
                  {importResult.warning ?? ""}
                  {importResult.warnings?.length ? ` ${importResult.warnings.join(" ")}` : ""}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

