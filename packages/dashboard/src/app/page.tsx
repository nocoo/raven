import { Suspense } from "react";
import type { Metadata } from "next";
import { Activity, Zap, Clock, AlertTriangle, Timer, Gauge } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { StatCard } from "@/components/stats/stat-card";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { AnalyticsCharts } from "./analytics-charts";
import { safeFetch } from "@/lib/proxy";
import type { SummaryStats, ExtendedTimeseriesBucket, BreakdownEntry, Percentiles } from "@/lib/types";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import {
  searchParamsToFilters,
  filtersToApiQuery,
  rangeToInterval,
} from "@/lib/analytics-filters";

export const metadata: Metadata = { title: "Overview" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function HomePage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  // Parse filters from URL
  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const interval = rangeToInterval(filters.range);

  // Fetch all data in parallel
  const [summaryResult, timeseriesResult, p95Result, modelBkResult, clientBkResult, strategyBkResult] =
    await Promise.all([
      safeFetch<SummaryStats>(`/api/stats/summary${apiQuery}`),
      safeFetch<ExtendedTimeseriesBucket[]>(
        `/api/stats/timeseries${apiQuery}${apiQuery ? "&" : "?"}interval=${interval}`,
      ),
      safeFetch<Percentiles>(`/api/stats/percentiles${apiQuery}${apiQuery ? "&" : "?"}metric=latency_ms`),
      safeFetch<BreakdownEntry[]>(`/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=model&limit=5&sort=count&order=desc`),
      safeFetch<BreakdownEntry[]>(`/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=client_name&limit=5&sort=count&order=desc`),
      safeFetch<BreakdownEntry[]>(`/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=strategy&limit=5&sort=count&order=desc`),
    ]);

  if (!summaryResult.ok) {
    return (
      <AppShell>
        <FetchError title="Failed to load dashboard" message={summaryResult.error} />
      </AppShell>
    );
  }

  const summary = summaryResult.data;
  const timeseries = timeseriesResult.ok ? timeseriesResult.data : [];
  const p95 = p95Result.ok ? p95Result.data : null;
  const modelBreakdown = modelBkResult.ok ? modelBkResult.data : [];
  const clientBreakdown = clientBkResult.ok ? clientBkResult.data : [];
  const strategyBreakdown = strategyBkResult.ok ? strategyBkResult.data : [];

  // Extract models list for filter dropdown
  const models = modelBreakdown.map((e) => e.key).filter(Boolean);
  const strategies = strategyBreakdown.map((e) => e.key).filter(Boolean);

  // Sparkline data from timeseries buckets
  const requestsSpark = timeseries.map((b) => b.count);
  const tokensSpark = timeseries.map((b) => b.total_tokens);
  const latencySpark = timeseries.map((b) => b.avg_latency_ms);

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Filter Bar */}
        <Suspense>
          <FilterBar models={models} strategies={strategies} />
        </Suspense>

        {/* Stat cards row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatCard
            icon={Activity}
            label="Total Requests"
            value={formatCompact(summary.total_requests)}
            sparkline={requestsSpark}
            className="animate-fade-up stagger-1"
          />
          <StatCard
            icon={AlertTriangle}
            label="Error Rate"
            value={formatPercent(summary.error_rate)}
            detail={`${summary.error_count} errors`}
            accent={summary.error_rate > 0.05 ? "danger" : "default"}
            className="animate-fade-up stagger-2"
          />
          <StatCard
            icon={Clock}
            label="Avg Latency"
            value={formatLatency(summary.avg_latency_ms)}
            sparkline={latencySpark}
            className="animate-fade-up stagger-3"
          />
          <StatCard
            icon={Gauge}
            label="P95 Latency"
            value={p95 ? formatLatency(p95.p95) : "—"}
            className="animate-fade-up stagger-4"
          />
          <StatCard
            icon={Timer}
            label="Avg TTFT"
            value={summary.avg_ttft_ms != null ? formatLatency(summary.avg_ttft_ms) : "—"}
            className="animate-fade-up stagger-5"
          />
          <StatCard
            icon={Zap}
            label="Total Tokens"
            value={formatCompact(summary.total_tokens)}
            sparkline={tokensSpark}
            className="animate-fade-up stagger-6"
          />
        </div>

        {/* Analytics charts */}
        <AnalyticsCharts
          timeseries={timeseries}
          modelBreakdown={modelBreakdown}
          clientBreakdown={clientBreakdown}
          strategyBreakdown={strategyBreakdown}
        />
      </div>
    </AppShell>
  );
}
