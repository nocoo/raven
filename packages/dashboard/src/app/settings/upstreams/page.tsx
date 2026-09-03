import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ProviderPublic } from "@/lib/types";
import { UpstreamsContent } from "./upstreams-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export const metadata = { title: "Upstreams" };

export default async function UpstreamsPage() {
  const result = await safeFetch<ProviderPublic[]>("/api/upstreams");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Upstreams" }]}>
        <div className="space-y-4 md:space-y-6">
          <PageHeader title="Upstreams" description="Configured upstream providers and their available models." />
          <FetchError title="Failed to load upstreams" message={result.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Upstreams" }]}>
      <div className="space-y-4 md:space-y-6">
        <PageHeader title="Upstreams" description="Configured upstream providers and their available models." />
        <UpstreamsContent providers={result.data} />
      </div>
    </AppShell>
  );
}
