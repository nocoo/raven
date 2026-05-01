import { Volume2, Shield, Sparkles, Wrench } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { StatCard } from "@/components/stats/stat-card";
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

  const data = settingsResult.data;
  const optEnabled = Object.values(data.optimizations).filter((o) => o.enabled).length;
  const optTotal = Object.keys(data.optimizations).length;
  const stEnabled = Object.values(data.server_tools).filter((t) => t.enabled).length;
  const stTotal = Object.keys(data.server_tools).length;

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Settings</h1>
          <p className="text-meta">Server status, sound notifications, IP whitelist and request optimizations.</p>
        </div>

        {/* Status overview tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          <StatCard
            icon={Volume2}
            label="Sound"
            value={data.sound.available ? (data.sound.enabled ? "On" : "Off") : "N/A"}
            detail={data.sound.available ? data.sound.sound_name : "unavailable"}
            accent={data.sound.available && data.sound.enabled ? "success" : "default"}
          />
          <StatCard
            icon={Shield}
            label="IP Whitelist"
            value={data.ip_whitelist.enabled ? "On" : "Off"}
            detail={`${data.ip_whitelist.ranges.length} range${data.ip_whitelist.ranges.length === 1 ? "" : "s"}`}
            accent={data.ip_whitelist.enabled ? "success" : "default"}
          />
          <StatCard
            icon={Sparkles}
            label="Optimizations"
            value={`${optEnabled} / ${optTotal}`}
            detail="enabled"
          />
          <StatCard
            icon={Wrench}
            label="Server Tools"
            value={`${stEnabled} / ${stTotal}`}
            detail="enabled"
          />
        </div>

        <SettingsContent data={data} />
        {data.sound.available && <SoundContent data={data.sound} />}
        <IPWhitelistContent data={data.ip_whitelist} />
        <OptimizationsContent data={data.optimizations} />
      </div>
    </AppShell>
  );
}
