import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { SettingsContent } from "./settings-content";
import { OptimizationsContent } from "./optimizations-content";
import { SoundContent } from "./sound-content";
import { IPWhitelistContent } from "./ip-whitelist-content";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const settingsResult = await safeFetch<SettingsData>("/api/settings");

  if (!settingsResult.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }]}>
        <FetchError title="Failed to load settings" message={settingsResult.error} />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }]}>
      <div className="space-y-8">
        <h1 className="text-lg font-semibold font-display">Settings</h1>
        <SettingsContent data={settingsResult.data} />
        {settingsResult.data.sound.available && <SoundContent data={settingsResult.data.sound} />}
        <IPWhitelistContent data={settingsResult.data.ip_whitelist} />
        <OptimizationsContent data={settingsResult.data.optimizations} />
      </div>
    </AppShell>
  );
}
