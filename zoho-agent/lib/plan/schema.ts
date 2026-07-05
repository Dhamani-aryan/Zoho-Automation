import { z } from "zod";

// Tolerate harmless model drift (case differences, numbers where strings are
// expected, omitted optional sections). Guardrails re-verify block slugs and
// field names afterwards, so leniency here does not weaken safety.
const lower = (v: string) => v.trim().toLowerCase();

export const planBlockSchema = z.object({
  slug: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({})
});

export const recordSelectorSchema = z.object({
  mode: z.string().transform(lower).pipe(z.enum(["tag", "ids", "names", "file", "filter"])),
  tag: z.preprocess((v) => (v == null ? undefined : v), z.coerce.string().optional()),
  module: z.string().transform(lower).pipe(z.enum(["deals", "contacts", "accounts"])),
  values: z.preprocess((v) => (v == null ? undefined : v), z.array(z.coerce.string()).optional()),
  // Models emit "filter": {} or nulled members when unused (the shape example
  // shows the key) — normalize empty/partial filters to undefined instead of
  // failing the whole plan.
  filter: z.preprocess(
    (value) => {
      if (!value || typeof value !== "object") return undefined;
      const o = value as Record<string, unknown>;
      const field = typeof o.field === "string" ? o.field.trim() : "";
      const op = typeof o.op === "string" ? o.op.trim().toLowerCase() : "";
      const val = o.value == null ? "" : String(o.value).trim();
      if (!field || !op || !val) return undefined;
      return { field, op, value: val };
    },
    z
      .object({
        field: z.string(),
        op: z.enum(["equals", "contains", "starts_with"]),
        value: z.string()
      })
      .optional()
  )
});

export const parsedPlanSchema = z.object({
  intent_summary: z.coerce.string().min(1),
  run_kind: z.string().transform(lower).pipe(z.enum(["read", "write"])),
  blocks: z.array(planBlockSchema).default([]),
  record_selector: recordSelectorSchema.default({ mode: "names", module: "deals", values: [] }),
  run_parameters: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(z.coerce.string()).default([]),
  missing_info: z.array(z.coerce.string()).default([])
});

export type ParsedPlanSchema = z.infer<typeof parsedPlanSchema>;

export function validateParsedPlan(value: unknown) {
  return parsedPlanSchema.safeParse(value);
}
