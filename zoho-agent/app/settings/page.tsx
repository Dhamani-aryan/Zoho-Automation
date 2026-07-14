import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { SettingsExtensionCard } from "@/components/settings-extension-card";
import { SettingsOpenAICard } from "@/components/settings-openai-card";

export default function SettingsPage() {
  return (
    <AppShell>
      <PageHeader
        eyebrow="Settings"
        title="Account settings"
        description="Connect the credentials used for command parsing and local Zoho execution."
      />
      <div className="space-y-5">
        <SettingsOpenAICard />
        <SettingsExtensionCard />
      </div>
    </AppShell>
  );
}

