import { z } from "zod";

export const planBlockSchema = z.object({
  slug: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({})
});

export const recordSelectorSchema = z.object({
  mode: z.enum(["tag", "ids", "names", "file", "filter"]),
  tag: z.string().optional(),
  module: z.enum(["deals", "contacts", "accounts"]),
  values: z.array(z.string()).optional(),
  filter: z.object({
    field: z.string(),
    op: z.enum(["equals", "contains", "starts_with"]),
    value: z.string()
  }).optional()
});

export const parsedPlanSchema = z.object({
  intent_summary: z.string().min(1),
  run_kind: z.enum(["read", "write"]),
  blocks: z.array(planBlockSchema),
  record_selector: recordSelectorSchema,
  run_parameters: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(z.string()).default([]),
  missing_info: z.array(z.string()).default([])
});

export type ParsedPlanSchema = z.infer<typeof parsedPlanSchema>;

export function validateParsedPlan(value: unknown) {
  return parsedPlanSchema.safeParse(value);
}
