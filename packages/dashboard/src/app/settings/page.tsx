import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { SettingsContent } from "./settings-content";
import { OptimizationsContent } from "./optimizations-content";
import { SoundContent } from "./sound-content";
import { IPWhitelistContent } from "./ip-whitelist-content";
import { Socks5Content, type Socks5Data } from "./socks5-content";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const [settingsResult, socks5Result] = await Promise.all([
    safeFetch<SettingsData>("/api/settings"),
    safeFetch<Socks5Data>("/api/settings/socks5"),
  ]);

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
        {socks5Result.ok && <Socks5Content data={socks5Result.data} />}
        <OptimizationsContent data={settingsResult.data.optimizations} />
      </div>
    </AppShell>
  );
}
