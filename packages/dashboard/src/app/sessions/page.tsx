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
import { SessionsTable } from "./sessions-table";

export const metadata = { title: "Sessions" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function SessionsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.ssort ?? "last_seen";
  const order = resolvedParams.sorder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=session_id&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Sessions" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Sessions</h1>
            <p className="text-meta">Aggregate per-session activity grouped by session_id.</p>
          </div>
          <FetchError title="Failed to load session data" message={result.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Sessions" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Sessions</h1>
          <p className="text-meta">Aggregate per-session activity grouped by session_id.</p>
        </div>
        <Suspense>
          <FilterBar compact />
        </Suspense>
        <SessionsTable data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}
