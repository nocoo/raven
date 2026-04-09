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
  const result = await safeFetch<SettingsData>("/api/settings");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }]}>
        <FetchError title="Failed to load settings" message={result.error} />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }]}>
      <div className="space-y-8">
        <h1 className="text-lg font-semibold font-display">Settings</h1>
        <SettingsContent data={result.data} />
        {result.data.sound.available && <SoundContent data={result.data.sound} />}
        <IPWhitelistContent data={result.data.ip_whitelist} />
        <OptimizationsContent data={result.data.optimizations} />
      </div>
    </AppShell>
  );
}
