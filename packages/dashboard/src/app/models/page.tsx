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
import { ModelExplorer } from "./model-explorer";

export const metadata = { title: "Models" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function ModelsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.msort ?? "count";
  const order = resolvedParams.morder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=model&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Models" }]}>
        <div className="space-y-4">
          <h1 className="text-lg font-semibold font-display">Model Explorer</h1>
          <FetchError title="Failed to load model stats" message={result.error} />
        </div>
      </AppShell>
    );
  }

  const models = result.data.map((e) => e.key).filter(Boolean);

  return (
    <AppShell breadcrumbs={[{ label: "Models" }]}>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold font-display">Model Explorer</h1>
        <Suspense>
          <FilterBar models={models} compact />
        </Suspense>
        <ModelExplorer data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}
