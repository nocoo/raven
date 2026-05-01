import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { safeFetch } from "@/lib/proxy";
import type { BreakdownEntry } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
} from "@/lib/analytics-filters";
import { ProvidersContent } from "./providers-content";

export const metadata = { title: "Providers & Strategy" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function ProvidersPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);

  // Parallel fetches for all three breakdowns
  const [strategyResult, upstreamResult, routingResult] = await Promise.all([
    safeFetch<BreakdownEntry[]>(
      `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=strategy&sort=count&order=desc&limit=20`,
    ),
    safeFetch<BreakdownEntry[]>(
      `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=upstream&sort=count&order=desc&limit=20`,
    ),
    safeFetch<BreakdownEntry[]>(
      `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=routing_path&sort=count&order=desc&limit=20`,
    ),
  ]);

  // If any critical fetch fails, show error
  if (!strategyResult.ok && !upstreamResult.ok && !routingResult.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Providers" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Providers &amp; Strategy</h1>
            <p className="text-meta">Routing strategy, upstream usage and resolved routing paths.</p>
          </div>
          <FetchError title="Failed to load provider data" message={strategyResult.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Providers" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Providers &amp; Strategy</h1>
          <p className="text-meta">Routing strategy, upstream usage and resolved routing paths.</p>
        </div>
        <Suspense>
          <FilterBar compact />
        </Suspense>
        <ProvidersContent
          strategies={strategyResult.ok ? strategyResult.data : []}
          upstreams={upstreamResult.ok ? upstreamResult.data : []}
          routingPaths={routingResult.ok ? routingResult.data : []}
        />
      </div>
    </AppShell>
  );
}
