import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const ALLOWED_MODULES = new Set(["Accounts", "Contacts", "Deals", "Tasks"]);

type ZohoField = {
  api_name?: string;
  field_label?: string;
  display_label?: string;
  label?: string;
  data_type?: string;
  pick_list_values?: unknown[];
  picklist_values?: unknown[];
  [key: string]: unknown;
};

function extractFields(payload: unknown): ZohoField[] {
  if (Array.isArray(payload)) return payload as ZohoField[];
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    if (Array.isArray(object.fields)) return object.fields as ZohoField[];
    if (Array.isArray(object.data)) return object.data as ZohoField[];
  }
  return [];
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON body is required." }, { status: 400 });
  }

  const { module, payload } = body as { module?: string; payload?: unknown };

  if (!module || !ALLOWED_MODULES.has(module)) {
    return NextResponse.json({ error: "Module must be Accounts, Contacts, Deals, or Tasks." }, { status: 400 });
  }

  const fields = extractFields(payload);
  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields array was found in the pasted JSON." }, { status: 400 });
  }

  const rows = fields
    .filter((field) => typeof field.api_name === "string" && field.api_name.trim().length > 0)
    .map((field) => ({
      module,
      api_name: field.api_name!.trim(),
      label:
        String(field.field_label ?? field.display_label ?? field.label ?? field.api_name).trim() ||
        field.api_name!.trim(),
      data_type: typeof field.data_type === "string" ? field.data_type : null,
      picklist_values: field.pick_list_values ?? field.picklist_values ?? [],
      raw_data: field,
      synced_at: new Date().toISOString()
    }));

  if (rows.length === 0) {
    return NextResponse.json({ error: "No fields had an api_name." }, { status: 400 });
  }

  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return NextResponse.json({
      module,
      rowsReceived: rows.length,
      rowsStored: 0,
      stored: false,
      sample: rows.slice(0, 10).map(({ api_name, label, data_type }) => ({
        api_name,
        label,
        data_type: data_type ?? undefined
      })),
      warning: "Supabase env values are not configured, so this was parsed but not stored."
    });
  }

  const { data, error } = await supabase
    .from("zoho_field_meta")
    .upsert(rows, { onConflict: "module,api_name" })
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rowsStored = data?.length ?? rows.length;
  const auditInsert = await auth.supabase.from("audit_events").insert({
    user_id: auth.user.id,
    event_type: "field_meta_sync",
    message: `Synced ${rowsStored} ${module} field metadata rows.`,
    metadata: {
      module,
      stored: rowsStored,
      skipped: rows.length - rowsStored
    }
  });

  if (auditInsert.error) {
    return NextResponse.json(
      { error: `Field metadata stored but audit insert failed: ${auditInsert.error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    module,
    rowsReceived: rows.length,
    rowsStored,
    stored: true,
    sample: rows.slice(0, 10).map(({ api_name, label, data_type }) => ({
      api_name,
      label,
      data_type: data_type ?? undefined
    }))
  });
}
