import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ProviderPublic } from "@/lib/types";
import { UpstreamsContent } from "./upstreams-content";

export const metadata = { title: "Upstreams" };

export default async function UpstreamsPage() {
  const result = await safeFetch<ProviderPublic[]>("/api/upstreams");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Upstreams" }]}>
        <FetchError title="Failed to load upstreams" message={result.error} />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }, { label: "Upstreams" }]}>
      <div className="space-y-6">
        <h1 className="text-lg font-semibold font-display">Upstreams</h1>
        <UpstreamsContent providers={result.data} />
      </div>
    </AppShell>
  );
}
