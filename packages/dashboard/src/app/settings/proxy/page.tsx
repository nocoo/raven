import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import { Socks5Content, type Socks5Data } from "../socks5-content";

export const metadata = { title: "Proxy" };

export default async function ProxyPage() {
  const result = await safeFetch<Socks5Data>("/api/settings/socks5");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Proxy" }]}>
        <FetchError title="Failed to load proxy settings" message={result.error} />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Proxy" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Proxy</h1>
          <p className="text-meta">SOCKS5 outbound proxy used for upstream connections.</p>
        </div>
        <Socks5Content data={result.data} />
      </div>
    </AppShell>
  );
}
