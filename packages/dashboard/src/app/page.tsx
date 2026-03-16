import { Suspense } from "react";
import type { Metadata } from "next";
import { Activity, Zap, Clock, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { StatCard } from "@/components/stats/stat-card";
import { FetchError } from "@/components/fetch-error";
import { OverviewCharts } from "./overview-charts";
import { RequestsContent } from "./requests/requests-content";
import { safeFetch } from "@/lib/proxy";
import type { OverviewStats, TimeseriesBucket, PaginatedRequests, ModelStats } from "@/lib/types";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";

export const metadata: Metadata = { title: "Overview" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function HomePage({ searchParams }: PageProps) {
  // Build query string for requests API from search params
  const resolvedParams = await searchParams;
  const requestParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) requestParams.set(key, value);
  }
  const requestsQuery = requestParams.toString();
  const requestsPath = `/api/requests${requestsQuery ? `?${requestsQuery}` : ""}`;

  const [overviewResult, timeseriesResult, requestsResult, modelsResult] = await Promise.all([
    safeFetch<OverviewStats>("/api/stats/overview"),
    safeFetch<TimeseriesBucket[]>("/api/stats/timeseries?interval=hour&range=24h"),
    safeFetch<PaginatedRequests>(requestsPath),
    safeFetch<ModelStats[]>("/api/stats/models"),
  ]);

  // If overview fetch failed, show error
  if (!overviewResult.ok) {
    return (
      <AppShell>
        <FetchError
          title="Failed to load dashboard"
          message={overviewResult.error}
        />
      </AppShell>
    );
  }
  if (!timeseriesResult.ok) {
    return (
      <AppShell>
        <FetchError
          title="Failed to load dashboard"
          message={timeseriesResult.error}
        />
      </AppShell>
    );
  }

  const overview = overviewResult.data;
  const timeseries = timeseriesResult.data;

  const errorRate = overview.total_requests > 0
    ? overview.error_count / overview.total_requests
    : 0;

  // Sparkline data from timeseries buckets
  const requestsSpark = timeseries.map((b) => b.count);
  const tokensSpark = timeseries.map((b) => b.total_tokens);
  const latencySpark = timeseries.map((b) => b.avg_latency_ms);

  // Graceful fallback for requests + models
  const models = modelsResult.ok
    ? modelsResult.data.map((m) => m.model)
    : [];

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Stat cards row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={Activity}
            label="Total Requests"
            value={formatCompact(overview.total_requests)}
            sparkline={requestsSpark}
          />
          <StatCard
            icon={Zap}
            label="Total Tokens"
            value={formatCompact(overview.total_tokens)}
            sparkline={tokensSpark}
          />
          <StatCard
            icon={Clock}
            label="Avg Latency"
            value={formatLatency(overview.avg_latency_ms)}
            sparkline={latencySpark}
          />
          <StatCard
            icon={AlertTriangle}
            label="Error Rate"
            value={formatPercent(errorRate)}
            detail={`${overview.error_count} errors`}
          />
        </div>

        {/* Charts */}
        <OverviewCharts timeseries={timeseries} />

        {/* Request log */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold">Request Log</h2>
          {requestsResult.ok ? (
            <Suspense fallback={<div className="text-muted-foreground text-sm">Loading...</div>}>
              <RequestsContent
                data={requestsResult.data.data}
                hasMore={requestsResult.data.has_more}
                nextCursor={requestsResult.data.next_cursor}
                total={requestsResult.data.total}
                models={models}
              />
            </Suspense>
          ) : (
            <FetchError
              title="Failed to load requests"
              message={requestsResult.error}
            />
          )}
        </div>
      </div>
    </AppShell>
  );
}
