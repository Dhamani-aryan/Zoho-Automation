import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { parseDelimitedText } from "@/lib/import/csv";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MODULES = new Set(["accounts", "contacts", "deals"]);

type Mapping = Record<string, string>;

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function getMapped(row: Record<string, string>, mapping: Mapping, key: string) {
  const column = mapping[key];
  return column ? clean(row[column]) : null;
}

function extractZohoId(url: string | null) {
  if (!url) return null;
  const match = url.match(/\/(?:Accounts|Contacts|Potentials)\/(\d+)/);
  return match?.[1] ?? null;
}

function toNumber(value: string | null) {
  if (!value) return null;
  const normalized = value.replace(/[$,]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12"
};

function validDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseClosingDate(value: string | null) {
  if (!value) return { value: null, unparseable: false };

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (validDateParts(year, month, day)) {
      return { value, unparseable: false };
    }
    return { value: null, unparseable: true };
  }

  const named = value.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (named) {
    const monthText = named[1].toLowerCase();
    const month = MONTHS[monthText];
    const day = Number(named[2]);
    const year = Number(named[3]);
    if (month && validDateParts(year, Number(month), day)) {
      return {
        value: `${year}-${month}-${String(day).padStart(2, "0")}`,
        unparseable: false
      };
    }
  }

  return { value: null, unparseable: true };
}

function buildRows(targetModule: string, rows: Record<string, string>[], mapping: Mapping) {
  if (targetModule === "accounts") {
    const builtRows = rows
      .map((row) => {
        const zohoUrl = getMapped(row, mapping, "zoho_url");
        return {
          zoho_account_id: getMapped(row, mapping, "zoho_account_id") ?? extractZohoId(zohoUrl),
          zoho_url: zohoUrl,
          account_name: getMapped(row, mapping, "account_name"),
          website: getMapped(row, mapping, "website"),
          phone: getMapped(row, mapping, "phone"),
          industry: getMapped(row, mapping, "industry"),
          owner: getMapped(row, mapping, "owner"),
          source: "csv_import",
          raw_data: row
        };
      })
      .filter((row) => row.account_name);

    return { rows: builtRows, warnings: [] };
  }

  if (targetModule === "contacts") {
    const builtRows = rows
      .map((row) => {
        const firstName = getMapped(row, mapping, "first_name");
        const lastName = getMapped(row, mapping, "last_name");
        const fullName = getMapped(row, mapping, "full_name") ?? [firstName, lastName].filter(Boolean).join(" ");
        const zohoUrl = getMapped(row, mapping, "zoho_url");
        return {
          zoho_contact_id: getMapped(row, mapping, "zoho_contact_id") ?? extractZohoId(zohoUrl),
          zoho_url: zohoUrl,
          first_name: firstName,
          last_name: lastName,
          full_name: clean(fullName),
          email: getMapped(row, mapping, "email"),
          title: getMapped(row, mapping, "title"),
          phone: getMapped(row, mapping, "phone"),
          mobile: getMapped(row, mapping, "mobile"),
          owner: getMapped(row, mapping, "owner"),
          source: "csv_import",
          raw_data: row
        };
      })
      .filter((row) => row.full_name);

    return { rows: builtRows, warnings: [] };
  }

  let unparseableClosingDates = 0;
  const builtRows = rows
    .map((row) => {
      const zohoUrl = getMapped(row, mapping, "zoho_url");
      const closingDate = parseClosingDate(getMapped(row, mapping, "closing_date"));
      if (closingDate.unparseable) unparseableClosingDates += 1;
      return {
        zoho_deal_id: getMapped(row, mapping, "zoho_deal_id") ?? extractZohoId(zohoUrl),
        zoho_url: zohoUrl,
        deal_name: getMapped(row, mapping, "deal_name"),
        stage: getMapped(row, mapping, "stage"),
        next_step: getMapped(row, mapping, "next_step"),
        owner: getMapped(row, mapping, "owner"),
        closing_date: closingDate.value,
        amount: toNumber(getMapped(row, mapping, "amount")),
        source: "csv_import",
        raw_data: row
      };
    })
    .filter((row) => row.deal_name);

  return {
    rows: builtRows,
    warnings:
      unparseableClosingDates > 0
        ? [`${unparseableClosingDates} rows had unparseable closing_date values`]
        : []
  };
}

function conflictColumn(targetModule: string) {
  if (targetModule === "accounts") return "zoho_account_id";
  if (targetModule === "contacts") return "zoho_contact_id";
  return "zoho_deal_id";
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const formData = await request.formData();
  const file = formData.get("file");
  const targetModule = String(formData.get("module") ?? "");
  const mappingText = String(formData.get("mapping") ?? "{}");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A CSV file is required." }, { status: 400 });
  }

  if (!MODULES.has(targetModule)) {
    return NextResponse.json({ error: "Module must be accounts, contacts, or deals." }, { status: 400 });
  }

  if (file.size > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: "Import files must be 5 MB or smaller." }, { status: 400 });
  }

  let mapping: Mapping;
  try {
    mapping = JSON.parse(mappingText) as Mapping;
  } catch {
    return NextResponse.json({ error: "Column mapping must be valid JSON." }, { status: 400 });
  }

  const parsed = parseDelimitedText(await file.text());
  const built = buildRows(targetModule, parsed.rows, mapping);
  const rows = built.rows;
  const warnings = built.warnings;
  const skipped = parsed.rows.length - rows.length;

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No importable rows were found. Check the required column mapping." },
      { status: 400 }
    );
  }

  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return NextResponse.json({
      stored: false,
      module: targetModule,
      parsedRows: parsed.rows.length,
      importableRows: rows.length,
      storedRows: 0,
      skippedRows: skipped,
      warnings,
      warning: "Supabase env values are not configured, so this was validated but not stored."
    });
  }

  const fileInsert = await auth.supabase
    .from("files")
    .insert({
      uploaded_by: auth.user.id,
      original_name: file.name,
      mime_type: file.type || "text/csv",
      file_kind: `${targetModule}_csv_import`,
      row_count: parsed.rows.length,
      metadata: { columns: parsed.columns, mapping }
    })
    .select("id")
    .single();

  if (fileInsert.error) {
    return NextResponse.json({ error: fileInsert.error.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from(targetModule)
    .upsert(rows as never, { onConflict: conflictColumn(targetModule) })
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const storedRows = data?.length ?? rows.length;
  const auditInsert = await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "csv_import",
    message: `Imported ${storedRows} ${targetModule} rows; skipped ${skipped}.`,
    metadata: {
      file_id: fileInsert.data.id,
      module: targetModule,
      stored: storedRows,
      skipped
    }
  });

  if (auditInsert.error) {
    return NextResponse.json(
      { error: `Import stored but audit insert failed: ${auditInsert.error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    stored: true,
    module: targetModule,
    fileId: fileInsert.data.id,
    parsedRows: parsed.rows.length,
    importableRows: rows.length,
    storedRows,
    skippedRows: skipped,
    warnings
  });
}
