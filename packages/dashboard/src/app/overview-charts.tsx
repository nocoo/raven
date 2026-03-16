"use client";

import { useState, useEffect } from "react";
import { RequestsChart } from "@/components/charts/requests-chart";
import { TokensChart } from "@/components/charts/tokens-chart";
import { LatencyChart } from "@/components/charts/latency-chart";
import { Skeleton } from "@/components/ui/skeleton";
import { CHART_HEIGHTS } from "@/lib/chart-config";
import type { TimeseriesBucket } from "@/lib/types";

interface OverviewChartsProps {
  timeseries: TimeseriesBucket[];
}

function ChartSkeleton() {
  const height = CHART_HEIGHTS.standard + 48;
  return (
    <div className="bg-secondary rounded-card p-4" style={{ height }}>
      <Skeleton className="h-4 w-32 mb-3" />
      <Skeleton className="h-full w-full rounded-widget" />
    </div>
  );
}

export function OverviewCharts({ timeseries }: OverviewChartsProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Add error_rate field for chart compatibility
  const withErrorRate = timeseries.map((b) => ({
    ...b,
    error_rate: 0, // not tracked per-bucket yet
  }));

  if (!mounted) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartSkeleton />
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <RequestsChart data={timeseries} />
      <TokensChart data={timeseries} />
      <LatencyChart data={withErrorRate} />
    </div>
  );
}
