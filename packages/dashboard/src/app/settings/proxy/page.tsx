import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import { Socks5Content, type Socks5Data } from "../socks5-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export const metadata = { title: "Proxy" };

export default async function ProxyPage() {
  const result = await safeFetch<Socks5Data>("/api/settings/socks5");

  if (!result.ok) {
    return (
      <div className="space-y-4">
        <PageHeader title="Proxy" description="SOCKS5 outbound connections." />
        <FetchError title="Failed to load proxy settings" message={result.error} />
      </div>
    );
  }

  return <Socks5Content data={result.data} />;
}
