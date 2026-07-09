import { NextResponse } from "next/server";
import { requireExtensionAuth } from "@/lib/extension/auth";

type ReportBody = {
  result?: unknown;
  error_message?: unknown;
  error_code?: unknown;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionAuth(request);
  if ("error" in auth) return auth.error;

  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as ReportBody | null;
    const errorMessage = typeof body?.error_message === "string" ? body.error_message.trim() : "";
    const errorCode = typeof body?.error_code === "string" ? body.error_code.trim() : "";
    const hasResult = body != null && Object.hasOwn(body, "result");

    if (!hasResult && !errorMessage) {
      return NextResponse.json({ error: "Report requires result or error_message." }, { status: 400 });
    }

    const completedAt = new Date().toISOString();
    const update =
      errorMessage || errorCode
        ? {
            status: "failed",
            result:
              body != null && Object.hasOwn(body, "result")
                ? { error_code: errorCode || null, result: body.result ?? null }
                : errorCode
                  ? { error_code: errorCode }
                  : null,
            error_message: errorMessage || errorCode,
            completed_at: completedAt
          }
        : {
            status: "done",
            result: body?.result ?? null,
            error_message: null,
            completed_at: completedAt
          };

    const { data: job, error: updateError } = await auth.service
      .from("tool_jobs")
      .update(update)
      .eq("id", id)
      .eq("user_id", auth.user.id)
      .eq("status", "running")
      .select("id,tool_name,status,result,error_message")
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    if (!job) {
      return NextResponse.json({ error: "Job is not running or does not belong to this extension user." }, { status: 409 });
    }

    await auth.service.from("audit_events").insert({
      user_id: auth.user.id,
      event_type: "ext_job_reported",
      message: `Extension reported job ${job.tool_name} as ${job.status}.`,
      metadata: {
        job_id: job.id,
        tool_name: job.tool_name,
        status: job.status,
        error_code: errorCode || null
      }
    });

    return NextResponse.json({
      ok: true,
      job: {
        id: job.id,
        tool_name: job.tool_name,
        status: job.status,
        result: job.result,
        error_message: job.error_message
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension job report failed unexpectedly.";
    console.error("[ext-jobs-report]", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
