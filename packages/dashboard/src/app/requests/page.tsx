import { Suspense } from "react";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ExtendedRequestRecord, SummaryStats, PaginatedRequests } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
} from "@/lib/analytics-filters";
import { FilterBar } from "@/components/analytics/filter-bar";
import { RequestsContent } from "./requests-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { keyLabel } from "@/lib/monitor";
import type { BreakdownEntry } from "@/lib/types";

export const metadata = { title: "Requests" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function RequestsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.sort ?? "timestamp";
  const order = resolvedParams.order ?? "desc";
  const cursor = resolvedParams.cursor;
  const offset = resolvedParams.offset;
  const limit = resolvedParams.limit ?? "50";

  // Build request list query
  const sep = apiQuery ? "&" : "?";
  const requestQuery = new URLSearchParams(apiQuery);
  requestQuery.set("sort", sort);
  requestQuery.set("order", order);
  requestQuery.set("limit", limit);
  if (cursor) requestQuery.set("cursor", cursor);
  if (offset) requestQuery.set("offset", offset);
  const requestPath = `/api/requests?${requestQuery}`;

  // Fetch data in parallel: requests + summary + models breakdown (for filter dropdown)
  const [requestsResult, summaryResult, modelsResult, keysResult] = await Promise.all([
    safeFetch<PaginatedRequests>(requestPath),
    safeFetch<SummaryStats>(`/api/stats/summary${apiQuery}`),
    safeFetch<{ key: string }[]>(
      `/api/stats/breakdown${apiQuery}${sep}by=model&sort=count&order=desc&limit=20`,
    ),
    safeFetch<BreakdownEntry[]>(`/api/stats/breakdown${apiQuery}${sep}by=key_id&sort=count&order=desc&limit=50`),
  ]);

  if (!requestsResult.ok) {
    return (
      <div className="space-y-4">
        <PageHeader title="Requests" description="Inspect every proxied request, with filters, sorting and pagination." />
        <FetchError title="Failed to load requests" message={requestsResult.error} />
      </div>
    );
  }

  const { data, has_more, next_cursor, total } = requestsResult.data;
  const models = modelsResult.ok
    ? modelsResult.data.map((e) => e.key).filter(Boolean)
    : [];
  const summary = summaryResult.ok ? summaryResult.data : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Requests"
        description="Trace a model, key or time window to individual calls. Open a request for its protocol route, timing and logs."
        filters={
          <Suspense>
            <FilterBar models={models} keys={keysResult.ok ? keysResult.data.map(entry => ({ id: entry.key, label: keyLabel(entry) })) : []} investigation autoRefresh />
          </Suspense>
        }
      />
      <Suspense>
        <RequestsContent
          data={data as ExtendedRequestRecord[]}
          hasMore={has_more}
          nextCursor={next_cursor}
          total={total}
          summary={summary}
        />
      </Suspense>
    </div>
  );
}
