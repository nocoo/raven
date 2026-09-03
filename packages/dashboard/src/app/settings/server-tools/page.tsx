import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { ServerToolsContent } from "./../server-tools-content";
import { DebugContent } from "./../debug-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export const metadata = { title: "Server Tools" };

export default async function ServerToolsPage() {
  const result = await safeFetch<SettingsData>("/api/settings");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Server Tools" }]}>
        <div className="space-y-4 md:space-y-6">
          <PageHeader title="Server Tools" description="Built-in MCP/server tools and request debug toggles." />
          <FetchError title="Failed to load settings" message={result.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Server Tools" }]}>
      <div className="space-y-4 md:space-y-6">
        <PageHeader title="Server Tools" description="Built-in MCP/server tools and request debug toggles." />
        <ServerToolsContent data={result.data.server_tools as typeof result.data.server_tools} />
        <DebugContent data={result.data.debug} />
      </div>
    </AppShell>
  );
}
