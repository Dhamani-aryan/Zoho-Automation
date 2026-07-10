import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";

export async function GET() {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  return NextResponse.json({
    approvals_enabled: auth.user.approvals_enabled,
    role: auth.user.role
  });
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin"]);
  if ("error" in auth) return auth.error;

  const body: unknown = await request.json().catch(() => ({}));
  const approvalsEnabled =
    body && typeof body === "object" ? (body as { approvals_enabled?: unknown }).approvals_enabled : undefined;
  if (typeof approvalsEnabled !== "boolean") {
    return NextResponse.json({ error: "approvals_enabled must be a boolean." }, { status: 400 });
  }

  const { error } = await auth.supabase
    .from("users")
    .update({ approvals_enabled: approvalsEnabled })
    .eq("id", auth.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ approvals_enabled: approvalsEnabled });
}
