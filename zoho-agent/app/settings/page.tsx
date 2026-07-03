import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { SettingsOpenAICard } from "@/components/settings-openai-card";

export default function SettingsPage() {
  return (
    <AppShell>
      <PageHeader
        eyebrow="Settings"
        title="Account settings"
        description="Connect the OpenAI credential used for your own command parsing runs."
      />
      <SettingsOpenAICard />
    </AppShell>
  );
}
