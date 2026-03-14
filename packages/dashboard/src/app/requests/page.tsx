import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { proxyFetch } from "@/lib/proxy";
import type { PaginatedRequests } from "@/lib/types";
import { RequestsContent } from "./requests-content";

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

async function getRequests(searchParams: Record<string, string | undefined>): Promise<PaginatedRequests> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value) params.set(key, value);
  }
  const queryString = params.toString();
  const path = `/api/requests${queryString ? `?${queryString}` : ""}`;

  try {
    return await proxyFetch<PaginatedRequests>(path);
  } catch {
    return { data: [], has_more: false };
  }
}

export default async function RequestsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const result = await getRequests(resolvedParams);

  return (
    <AppShell breadcrumbs={[{ label: "Requests" }]}>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Request Log</h1>
        <Suspense fallback={<div className="text-muted-foreground">Loading...</div>}>
          <RequestsContent
            data={result.data}
            hasMore={result.has_more}
            nextCursor={result.next_cursor}
            total={result.total}
          />
        </Suspense>
      </div>
    </AppShell>
  );
}
