import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
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
        <div className="space-y-4 md:space-y-6">
          <PageHeader title="Settings" description="Server status, IP whitelist, CORS and request optimizations." />
          <FetchError title="Failed to load settings" message={settingsResult.error} />
        </div>
      </AppShell>
    );
  }

  const data = settingsResult.data;

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }]}>
      <div className="space-y-4 md:space-y-6">
        <PageHeader title="Settings" description="Server status, IP whitelist, CORS and request optimizations." />

        <SettingsContent data={data} />
        <IPWhitelistContent data={data.ip_whitelist} />
        <CorsContent data={data.cors} />
        <OptimizationsContent data={data.optimizations} />
      </div>
    </AppShell>
  );
}
