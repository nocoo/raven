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
      <div className="mx-auto w-full max-w-7xl space-y-4">
        <PageHeader title="Settings" description="Server status, IP whitelist, CORS and request optimizations." />
        <FetchError title="Failed to load settings" message={settingsResult.error} />
      </div>
    );
  }

  const data = settingsResult.data;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <PageHeader title="Settings" description="Server status, IP whitelist, CORS and request optimizations." />

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <SettingsContent data={data} />
        <OptimizationsContent data={data.optimizations} />
        <IPWhitelistContent data={data.ip_whitelist} />
        <CorsContent data={data.cors} />
      </div>
    </div>
  );
}
