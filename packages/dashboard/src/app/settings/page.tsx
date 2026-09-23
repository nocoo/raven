import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { SettingsContent } from "./settings-content";
import { OptimizationsContent } from "./optimizations-content";
import { IPWhitelistContent } from "./ip-whitelist-content";
import { CorsContent } from "./cors-content";
import { HistoryRetentionContent } from "./history-retention-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export const metadata = { title: "General" };

export default async function SettingsPage() {
  const settingsResult = await safeFetch<SettingsData>("/api/settings");

  if (!settingsResult.ok) {
    return (
      <div className="space-y-4">
        <PageHeader title="General" description="Version overrides, request optimizations and access controls." />
        <FetchError title="Failed to load settings" message={settingsResult.error} />
      </div>
    );
  }

  const data = settingsResult.data;

  return (
    <div className="space-y-4">
      <PageHeader title="General" description="Version overrides, request optimizations and access controls." />

      <div className="settings-grid">
        <HistoryRetentionContent days={data.history_retention_days} />
        <SettingsContent data={data} />
        <OptimizationsContent data={data.optimizations} />
        <IPWhitelistContent data={data.ip_whitelist} />
        <CorsContent data={data.cors} />
      </div>
    </div>
  );
}
