"use client";

import { useState, useEffect } from "react";
import { RequestsChart } from "@/components/charts/requests-chart";
import { TokensChart } from "@/components/charts/tokens-chart";
import { LatencyChart } from "@/components/charts/latency-chart";
import type { TimeseriesBucket } from "@/lib/types";

interface OverviewChartsProps {
  timeseries: TimeseriesBucket[];
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
        <div className="bg-secondary rounded-card p-4 h-[268px]" />
        <div className="bg-secondary rounded-card p-4 h-[268px]" />
        <div className="bg-secondary rounded-card p-4 h-[268px]" />
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
