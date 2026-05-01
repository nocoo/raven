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
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Upstreams</h1>
          <p className="text-meta">Configured upstream providers and their available models.</p>
        </div>
        <UpstreamsContent providers={result.data} />
      </div>
    </AppShell>
  );
}
