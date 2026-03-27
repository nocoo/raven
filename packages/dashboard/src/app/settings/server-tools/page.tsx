import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { ServerToolsContent } from "./../server-tools-content";
import { DebugContent } from "./../debug-content";

export const metadata = { title: "Server Tools" };

export default async function ServerToolsPage() {
  const result = await safeFetch<SettingsData>("/api/settings");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Server Tools" }]}>
        <FetchError title="Failed to load settings" message={result.error} />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Server Tools" }]}>
      <div className="space-y-8">
        <h1 className="text-lg font-semibold font-display">Server Tools</h1>
        <ServerToolsContent data={result.data.server_tools as typeof result.data.server_tools} />
        <DebugContent data={result.data.debug} />
      </div>
    </AppShell>
  );
}
