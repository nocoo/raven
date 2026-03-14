import { Activity, Zap, Clock, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { StatCard } from "@/components/stats/stat-card";
import { OverviewCharts } from "./overview-charts";
import { proxyFetch } from "@/lib/proxy";
import type { OverviewStats, TimeseriesBucket } from "@/lib/types";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";

async function getOverviewData() {
  try {
    const [overview, timeseries] = await Promise.all([
      proxyFetch<OverviewStats>("/api/stats/overview"),
      proxyFetch<TimeseriesBucket[]>("/api/stats/timeseries?interval=hour&range=24h"),
    ]);
    return { overview, timeseries };
  } catch {
    return {
      overview: { total_requests: 0, total_tokens: 0, error_count: 0, avg_latency_ms: 0 },
      timeseries: [] as TimeseriesBucket[],
    };
  }
}

export default async function HomePage() {
  const { overview, timeseries } = await getOverviewData();

  const errorRate = overview.total_requests > 0
    ? overview.error_count / overview.total_requests
    : 0;

  return (
    <AppShell>
      <div className="space-y-4">
        {/* Stat cards row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={Activity}
            label="Total Requests"
            value={formatCompact(overview.total_requests)}
          />
          <StatCard
            icon={Zap}
            label="Total Tokens"
            value={formatCompact(overview.total_tokens)}
          />
          <StatCard
            icon={Clock}
            label="Avg Latency"
            value={formatLatency(overview.avg_latency_ms)}
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
      </div>
    </AppShell>
  );
}
