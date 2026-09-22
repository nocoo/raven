import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ApiKeyPublic, ConnectionInfo } from "@/lib/types";
import type { RoutingRule } from "@/lib/routing-types";
import { ConnectContent } from "./connect-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export const metadata = { title: "Connect" };

export default async function ConnectPage() {
  const [keysResult, connResult, rulesResult] = await Promise.all([
    safeFetch<ApiKeyPublic[]>("/api/keys"),
    safeFetch<ConnectionInfo>("/api/connection-info"),
    safeFetch<RoutingRule[]>("/api/routing-rules"),
  ]);

  if (!keysResult.ok || !connResult.ok || !rulesResult.ok) {
    const errorMsg = !keysResult.ok ? keysResult.error : !connResult.ok ? connResult.error : !rulesResult.ok ? rulesResult.error : "Unknown error";
    return (
      <div className="space-y-4 md:space-y-6">
        <PageHeader title="Connect" description="API keys and the proxy endpoints to wire into your client." />
        <FetchError title="Failed to load connection info" message={errorMsg} />
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <PageHeader title="Connect" description="API keys and the proxy endpoints to wire into your client." />
      <ConnectContent
        keys={keysResult.data}
        connectionInfo={connResult.data}
        rules={rulesResult.data}
      />
    </div>
  );
}
