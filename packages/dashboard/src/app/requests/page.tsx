import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ExtendedRequestRecord, SummaryStats, PaginatedRequests } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
} from "@/lib/analytics-filters";
import { RequestsContent } from "./requests-content";

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
  let requestPath = `/api/requests${apiQuery}${sep}sort=${sort}&order=${order}&limit=${limit}`;
  if (cursor) requestPath += `&cursor=${cursor}`;
  if (offset) requestPath += `&offset=${offset}`;

  // Fetch data in parallel: requests + summary + models breakdown (for filter dropdown)
  const [requestsResult, summaryResult, modelsResult] = await Promise.all([
    safeFetch<PaginatedRequests>(requestPath),
    safeFetch<SummaryStats>(`/api/stats/summary${apiQuery}`),
    safeFetch<{ key: string }[]>(
      `/api/stats/breakdown${apiQuery}${sep}by=model&sort=count&order=desc&limit=20`,
    ),
  ]);

  if (!requestsResult.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Requests" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Requests</h1>
            <p className="text-meta">Inspect every proxied request, with filters, sorting and pagination.</p>
          </div>
          <FetchError title="Failed to load requests" message={requestsResult.error} />
        </div>
      </AppShell>
    );
  }

  const { data, has_more, next_cursor, total } = requestsResult.data;
  const models = modelsResult.ok
    ? modelsResult.data.map((e) => e.key).filter(Boolean)
    : [];
  const summary = summaryResult.ok ? summaryResult.data : null;

  return (
    <AppShell breadcrumbs={[{ label: "Requests" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Requests</h1>
          <p className="text-meta">Inspect every proxied request, with filters, sorting and pagination.</p>
        </div>
        <Suspense>
          <RequestsContent
            data={data as ExtendedRequestRecord[]}
            hasMore={has_more}
            nextCursor={next_cursor}
            total={total}
            models={models}
            summary={summary}
          />
        </Suspense>
      </div>
    </AppShell>
  );
}
