import { Sparkles, TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SkillGuideParam = {
  name: string;
  description: string;
  example: string;
};

type SkillGuideRow = {
  id: string;
  name: string;
  intent: string;
  preconditions: string;
  method_api: string;
  method_ui: string;
  gotchas: string;
  verification: string;
  stop_conditions: string;
  params: SkillGuideParam[] | null;
  version: number;
  updated_at: string;
  created_at: string;
};

// Mirrors CORE_GUIDE_PATTERNS in lib/agent/guide-routing.ts: these four guides
// are auto-loaded into the agent's system prompt when a request matches their
// keywords. Display-only; the routing source of truth stays in guide-routing.ts.
const AUTO_TRIGGER_KEYWORDS: Record<string, string[]> = {
  "email-scheduling": ["email", "composer", "schedule", "subject", "recipient", "cc", "signature"],
  "deals-editing": ["deal", "potential", "next step"],
  "contacts-editing": ["contact", "person", "people"],
  "accounts-editing": ["account", "company"]
};

function formatTimestamp(value: string) {
  try {
    return new Date(value).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata"
    });
  } catch {
    return value;
  }
}

function GuideSection({ label, content }: { label: string; content: string }) {
  if (!content.trim()) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className="whitespace-pre-wrap rounded-md border border-line bg-slate-50 p-3 text-sm leading-6 text-ink">
        {content}
      </div>
    </div>
  );
}

export default async function SkillsPage() {
  const supabase = await createServerSupabaseClient();
  let guides: SkillGuideRow[] = [];
  let loadError: string | null = null;

  if (!supabase) {
    loadError = "Supabase is not configured.";
  } else {
    const { data, error } = await supabase
      .from("skill_guides")
      .select(
        "id,name,intent,preconditions,method_api,method_ui,gotchas,verification,stop_conditions,params,version,updated_at,created_at"
      )
      .order("updated_at", { ascending: false });
    if (error) loadError = error.message;
    guides = (data ?? []) as SkillGuideRow[];
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="Agent memory"
        title="Skill guides"
        description="Reusable workflow methods the agent has learned. Core guides are auto-loaded into the agent's prompt when a request matches their trigger keywords; guides store method only, never run data."
      />

      {loadError ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          Could not load skill guides: {loadError}
        </div>
      ) : guides.length === 0 ? (
        <div className="rounded-md border border-line bg-white p-8 text-center text-sm text-muted">
          No skill guides saved yet. Walk the agent through a task in teach mode, then ask it to
          &ldquo;save this as a skill guide&rdquo;.
        </div>
      ) : (
        <div className="space-y-4">
          {guides.map((guide) => {
            const params = Array.isArray(guide.params) ? guide.params : [];
            const triggers = AUTO_TRIGGER_KEYWORDS[guide.name];
            return (
              <details
                key={guide.id}
                className="group rounded-lg border border-line bg-white shadow-sm open:shadow-md"
              >
                <summary className="flex cursor-pointer flex-col gap-2 p-4 [&::-webkit-details-marker]:hidden sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-ink">{guide.name}</span>
                      <span className="rounded-full border border-line bg-slate-50 px-2 py-0.5 text-xs text-muted">
                        v{guide.version}
                      </span>
                      {triggers ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-accent">
                          <Sparkles className="h-3 w-3" />
                          auto-loaded
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted group-open:whitespace-normal">{guide.intent}</p>
                  </div>
                  <div className="shrink-0 text-xs text-muted">Updated {formatTimestamp(guide.updated_at)}</div>
                </summary>

                <div className="space-y-4 border-t border-line p-4">
                  {triggers ? (
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Auto-trigger keywords
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {triggers.map((keyword) => (
                          <span
                            key={keyword}
                            className="rounded-md border border-line bg-slate-50 px-2 py-0.5 text-xs text-ink"
                          >
                            {keyword}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {params.length > 0 ? (
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Parameters ({params.length})
                      </div>
                      <div className="overflow-x-auto rounded-md border border-line">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-slate-50 text-xs uppercase tracking-[0.05em] text-muted">
                            <tr>
                              <th className="px-3 py-2 font-semibold">Name</th>
                              <th className="px-3 py-2 font-semibold">Description</th>
                              <th className="px-3 py-2 font-semibold">Example</th>
                            </tr>
                          </thead>
                          <tbody>
                            {params.map((param) => (
                              <tr key={param.name} className="border-t border-line align-top">
                                <td className="px-3 py-2 font-mono text-xs text-ink">{param.name}</td>
                                <td className="px-3 py-2 text-muted">{param.description}</td>
                                <td className="px-3 py-2 font-mono text-xs text-muted">{param.example}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  <GuideSection label="Preconditions" content={guide.preconditions} />
                  <GuideSection label="Method (API)" content={guide.method_api} />
                  <GuideSection label="Method (UI)" content={guide.method_ui} />
                  <GuideSection label="Gotchas" content={guide.gotchas} />
                  <GuideSection label="Verification" content={guide.verification} />
                  <GuideSection label="Stop conditions" content={guide.stop_conditions} />

                  <div className="text-xs text-muted">
                    Created {formatTimestamp(guide.created_at)} · Updated {formatTimestamp(guide.updated_at)} ·
                    Version {guide.version}
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
