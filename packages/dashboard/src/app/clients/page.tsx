import { Suspense } from "react";
import { Users, Activity, Zap, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { StatCard } from "@/components/stats/stat-card";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { safeFetch } from "@/lib/proxy";
import { formatCompact, formatPercent } from "@/lib/chart-config";
import type { BreakdownEntry } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
} from "@/lib/analytics-filters";
import { ClientsTable } from "./clients-table";

export const metadata = { title: "Clients" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function ClientsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.csort ?? "count";
  const order = resolvedParams.corder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=client_name&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Clients" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Clients</h1>
            <p className="text-meta">Top client applications by request volume.</p>
          </div>
          <FetchError title="Failed to load client data" message={result.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Clients" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Clients</h1>
          <p className="text-meta">Top client applications by request volume.</p>
        </div>
        <Suspense>
          <FilterBar compact />
        </Suspense>
        {(() => {
          const totalClients = result.data.length;
          const totalRequests = result.data.reduce((s, e) => s + e.count, 0);
          const totalTokens = result.data.reduce((s, e) => s + e.total_tokens, 0);
          const totalErrors = result.data.reduce(
            (s, e) => s + e.error_rate * e.count,
            0,
          );
          const avgErrorRate =
            totalRequests > 0 ? totalErrors / totalRequests : 0;
          return (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
              <StatCard icon={Users} label="Total Clients" value={formatCompact(totalClients)} />
              <StatCard icon={Activity} label="Total Requests" value={formatCompact(totalRequests)} />
              <StatCard icon={Zap} label="Total Tokens" value={formatCompact(totalTokens)} />
              <StatCard
                icon={AlertTriangle}
                label="Avg Error Rate"
                value={formatPercent(avgErrorRate)}
                accent={avgErrorRate > 0.1 ? "danger" : avgErrorRate > 0.05 ? "warning" : "default"}
              />
            </div>
          );
        })()}
        <ClientsTable data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}
