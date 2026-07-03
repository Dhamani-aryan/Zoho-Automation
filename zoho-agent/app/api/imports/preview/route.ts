import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth/guards";
import { extractMarkdownSections, parseDelimitedText } from "@/lib/import/csv";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function getFileType(name: string, type: string): "csv" | "markdown" | "text" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || type.includes("csv")) {
    return "csv";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "markdown";
  }
  return "text";
}

export async function POST(request: Request) {
  const auth = await requireApiRole(["admin", "operator"]);
  if ("error" in auth) return auth.error;

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A file upload is required." }, { status: 400 });
  }

  if (file.size > MAX_PREVIEW_BYTES) {
    return NextResponse.json(
      { error: "Preview files must be 2 MB or smaller." },
      { status: 400 }
    );
  }

  const text = await file.text();
  const fileType = getFileType(file.name, file.type);

  if (fileType === "markdown") {
    const sections = extractMarkdownSections(text);
    return NextResponse.json({
      fileName: file.name,
      fileType,
      rowCount: sections.length,
      columns: ["Section"],
      rows: sections.slice(0, 20).map((section) => ({ Section: section })),
      sections: sections.slice(0, 50),
      warnings:
        sections.length === 0
          ? ["No Markdown headings were found. Draft parser tests need contact sections."]
          : []
    });
  }

  const parsed = parseDelimitedText(text);
  return NextResponse.json({
    fileName: file.name,
    fileType,
    rowCount: parsed.rows.length,
    columns: parsed.columns,
    rows: parsed.rows.slice(0, 25),
    warnings: parsed.warnings
  });
}
