import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ApiKeyPublic, ConnectionInfo } from "@/lib/types";
import { ConnectContent } from "./connect-content";

export default async function ConnectPage() {
  const [keysResult, connResult] = await Promise.all([
    safeFetch<ApiKeyPublic[]>("/api/keys"),
    safeFetch<ConnectionInfo>("/api/connection-info"),
  ]);

  if (!keysResult.ok || !connResult.ok) {
    const errorMsg = !keysResult.ok ? keysResult.error : !connResult.ok ? connResult.error : "Unknown error";
    return (
      <AppShell breadcrumbs={[{ label: "Connect" }]}>
        <FetchError title="Failed to load connection info" message={errorMsg} />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Connect" }]}>
      <div className="space-y-6">
        <h1 className="text-lg font-semibold font-display">Connect</h1>
        <ConnectContent
          keys={keysResult.data}
          connectionInfo={connResult.data}
        />
      </div>
    </AppShell>
  );
}
