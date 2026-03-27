import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { SettingsContent } from "./settings-content";
import { OptimizationsContent } from "./optimizations-content";
import { DebugContent } from "./debug-content";
import { ServerToolsContent } from "./server-tools-content";

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
        <OptimizationsContent data={result.data.optimizations} />
        <DebugContent data={result.data.debug} />
        <ServerToolsContent data={result.data.server_tools as typeof result.data.server_tools} />
      </div>
    </AppShell>
  );
}
