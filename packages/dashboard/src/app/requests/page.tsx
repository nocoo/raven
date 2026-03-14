import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { PaginatedRequests, ModelStats } from "@/lib/types";
import { RequestsContent } from "./requests-content";

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function RequestsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) params.set(key, value);
  }
  const queryString = params.toString();
  const requestsPath = `/api/requests${queryString ? `?${queryString}` : ""}`;

  const [requestsResult, modelsResult] = await Promise.all([
    safeFetch<PaginatedRequests>(requestsPath),
    safeFetch<ModelStats[]>("/api/stats/models"),
  ]);

  if (!requestsResult.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Requests" }]}>
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Request Log</h1>
          <FetchError
            title="Failed to load requests"
            message={requestsResult.error}
          />
        </div>
      </AppShell>
    );
  }

  // Models list for filter dropdown — graceful fallback to empty if fetch fails
  const models = modelsResult.ok
    ? modelsResult.data.map((m) => m.model)
    : [];

  return (
    <AppShell breadcrumbs={[{ label: "Requests" }]}>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Request Log</h1>
        <Suspense fallback={<div className="text-muted-foreground">Loading...</div>}>
          <RequestsContent
            data={requestsResult.data.data}
            hasMore={requestsResult.data.has_more}
            nextCursor={requestsResult.data.next_cursor}
            total={requestsResult.data.total}
            models={models}
          />
        </Suspense>
      </div>
    </AppShell>
  );
}
