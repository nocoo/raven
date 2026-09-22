import { PageHeader } from "@nocoo/basalt/components/page-header";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ProviderPublic, RoutingRule } from "@/lib/routing-types";
import { RulesContent } from "./rules-content";

export const metadata = { title: "Routing Rules" };
export default async function RulesPage() {
  const [rules, upstreams] = await Promise.all([safeFetch<RoutingRule[]>("/api/routing-rules"), safeFetch<ProviderPublic[]>("/api/upstreams")]);
  if (!rules.ok || !upstreams.ok) return <div className="space-y-4"><PageHeader title="Routing Rules" /><FetchError title="Failed to load routing" message={!rules.ok ? rules.error : !upstreams.ok ? upstreams.error : "Failed to load routing"} /></div>;
  return <RulesContent rules={rules.data} upstreams={upstreams.data} />;
}
