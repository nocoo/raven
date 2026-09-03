import { Shield, Sparkles, Wrench, Globe } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { StatCard } from "@/components/stats/stat-card";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { SettingsContent } from "./settings-content";
import { OptimizationsContent } from "./optimizations-content";
import { IPWhitelistContent } from "./ip-whitelist-content";
import { CorsContent } from "./cors-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

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
        <PageHeader title="Settings" description="Server status, IP whitelist, CORS and request optimizations." />

        {/* Status overview tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          <StatCard
            icon={Shield}
            label="IP Whitelist"
            value={data.ip_whitelist.enabled ? "On" : "Off"}
            detail={`${data.ip_whitelist.ranges.length} range${data.ip_whitelist.ranges.length === 1 ? "" : "s"}`}
            accent={data.ip_whitelist.enabled ? "success" : "default"}
          />
          <StatCard
            icon={Globe}
            label="CORS"
            value={data.cors.enabled ? "On" : "Off"}
            detail={`${data.cors.allowed_origins.length} origin${data.cors.allowed_origins.length === 1 ? "" : "s"}`}
            accent={data.cors.enabled ? "success" : "default"}
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
        <IPWhitelistContent data={data.ip_whitelist} />
        <CorsContent data={data.cors} />
        <OptimizationsContent data={data.optimizations} />
      </div>
    </AppShell>
  );
}
