import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import { Socks5Content, type Socks5Data } from "../socks5-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

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
        <PageHeader title="Proxy" description="SOCKS5 outbound proxy used for upstream connections." />
        <Socks5Content data={result.data} />
      </div>
    </AppShell>
  );
}
