import { PageHeader } from "@nocoo/basalt/components/page-header";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { MigrationSummary, ProviderPublic } from "@/lib/routing-types";
import { UpstreamsContent } from "./upstreams-content";

export const metadata = { title: "Upstreams" };
export default async function UpstreamsPage() {
  const [upstreams, migration] = await Promise.all([safeFetch<ProviderPublic[]>("/api/upstreams"), safeFetch<MigrationSummary | null>("/api/upstreams/migration")]);
  if (!upstreams.ok || !migration.ok) return <div className="space-y-4"><PageHeader title="Upstreams" /><FetchError title="Failed to load upstreams" message={!upstreams.ok ? upstreams.error : !migration.ok ? migration.error : "Failed to load upstreams"} /></div>;
  return <UpstreamsContent upstreams={upstreams.data} migration={migration.data} />;
}
