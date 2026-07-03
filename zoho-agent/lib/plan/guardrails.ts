import type { UserRole } from "@/lib/types";
import type { ParsedPlan } from "@/lib/llm/provider";

type BlockCatalogRow = {
  slug: string;
  admin_only?: boolean;
};

type FieldMetaRow = {
  module: string;
  api_name: string;
};

function moduleForBlock(slug: string) {
  if (slug.includes("deal")) return "Deals";
  if (slug.includes("contact")) return "Contacts";
  if (slug.includes("account")) return "Accounts";
  return null;
}

export function applyPlanGuardrails({
  plan,
  actionBlocks,
  fieldMeta,
  role
}: {
  plan: ParsedPlan;
  actionBlocks: BlockCatalogRow[];
  fieldMeta: FieldMetaRow[];
  role: UserRole;
}) {
  const allowedSlugs = new Set(actionBlocks.map((block) => block.slug));
  const adminOnly = new Set(actionBlocks.filter((block) => block.admin_only).map((block) => block.slug));
  const fieldNamesByModule = new Map<string, Set<string>>();

  for (const field of fieldMeta) {
    const existing = fieldNamesByModule.get(field.module) ?? new Set<string>();
    existing.add(field.api_name);
    fieldNamesByModule.set(field.module, existing);
  }

  const missing = [...plan.missing_info];
  const filteredBlocks = plan.blocks.filter((block) => {
    if (!allowedSlugs.has(block.slug)) {
      missing.push(`Unknown action block: ${block.slug}`);
      return false;
    }

    if (adminOnly.has(block.slug) && role !== "admin") {
      missing.push(`Admin role required for action block: ${block.slug}`);
      return false;
    }

    const fieldApiName = block.config.field_api_name;
    if (typeof fieldApiName === "string") {
      const crmModule = moduleForBlock(block.slug);
      if (crmModule && !fieldNamesByModule.get(crmModule)?.has(fieldApiName)) {
        missing.push(`Unknown ${crmModule} field api_name: ${fieldApiName}`);
        return false;
      }
      if (fieldApiName === "Stage" && role !== "admin") {
        missing.push("Admin role required for bulk Stage edits.");
        return false;
      }
    }

    return true;
  });

  return {
    ...plan,
    blocks: filteredBlocks,
    missing_info: missing
  };
}
