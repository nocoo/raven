import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ApiKeyPublic, ConnectionInfo, ModelsResponse } from "@/lib/types";
import { ConnectContent } from "./connect-content";

export const metadata = { title: "Connect" };

export default async function ConnectPage() {
  const [keysResult, connResult, modelsResult] = await Promise.all([
    safeFetch<ApiKeyPublic[]>("/api/keys"),
    safeFetch<ConnectionInfo>("/api/connection-info"),
    safeFetch<ModelsResponse>("/api/models"),
  ]);

  if (!keysResult.ok || !connResult.ok) {
    const errorMsg = !keysResult.ok ? keysResult.error : !connResult.ok ? connResult.error : "Unknown error";
    return (
      <AppShell breadcrumbs={[{ label: "Connect" }]}>
        <FetchError title="Failed to load connection info" message={errorMsg} />
      </AppShell>
    );
  }

  // Models fetch failure is non-fatal - we can still show the page with empty models
  const models = modelsResult.ok ? modelsResult.data.data : [];

  return (
    <AppShell breadcrumbs={[{ label: "Connect" }]}>
      <div className="space-y-6">
        <h1 className="text-lg font-semibold font-display">Connect</h1>
        <ConnectContent
          keys={keysResult.data}
          connectionInfo={connResult.data}
          models={models}
        />
      </div>
    </AppShell>
  );
}
