import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { PaginatedRequests } from "@/lib/types";
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
  const path = `/api/requests${queryString ? `?${queryString}` : ""}`;

  const result = await safeFetch<PaginatedRequests>(path);

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Requests" }]}>
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Request Log</h1>
          <FetchError
            title="Failed to load requests"
            message={result.error}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Requests" }]}>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Request Log</h1>
        <Suspense fallback={<div className="text-muted-foreground">Loading...</div>}>
          <RequestsContent
            data={result.data.data}
            hasMore={result.data.has_more}
            nextCursor={result.data.next_cursor}
            total={result.data.total}
          />
        </Suspense>
      </div>
    </AppShell>
  );
}
