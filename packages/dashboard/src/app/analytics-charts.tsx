"use client";

import { useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CHART_COLORS,
  AXIS_CONFIG,
  TOOLTIP_STYLES,
  RESPONSIVE_CONTAINER_PROPS,
  CHART_HEIGHTS,
  ANIMATION_PROPS,
  formatBucketTime,
  formatCompact,
  formatLatency,
} from "@/lib/chart-config";
import type { ExtendedTimeseriesBucket, BreakdownEntry } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label, formatter }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
  formatter?: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{label ? formatBucketTime(label) : ""}</p>
      {payload.map((entry) => (
        <p key={entry.name} className={TOOLTIP_STYLES.value}>
          <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: entry.color }} />
          {entry.name}: {formatter ? formatter(entry.value, entry.name) : entry.value.toLocaleString()}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  const height = CHART_HEIGHTS.standard + 48;
  return (
    <div className="bg-secondary rounded-card p-4" style={{ height }}>
      <Skeleton className="h-4 w-32 mb-3" />
      <Skeleton className="h-full w-full rounded-widget" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traffic Panel
// ---------------------------------------------------------------------------

function TrafficVolumeChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Request Volume</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="successFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="errorFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.danger} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.danger} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis {...AXIS_CONFIG} />
            <Tooltip content={<ChartTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="success_count"
              name="Success"
              stackId="volume"
              stroke={CHART_COLORS.primary}
              fill="url(#successFill)"
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
            <Area
              type="monotone"
              dataKey="error_count"
              name="Errors"
              stackId="volume"
              stroke={CHART_COLORS.danger}
              fill="url(#errorFill)"
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function StreamSyncChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Stream vs Sync</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis {...AXIS_CONFIG} />
            <Tooltip content={<ChartTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="stream_count"
              name="Stream"
              stackId="mode"
              stroke={CHART_COLORS.palette[2]}
              fill={CHART_COLORS.palette[2]}
              fillOpacity={0.2}
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
            <Area
              type="monotone"
              dataKey="sync_count"
              name="Sync"
              stackId="mode"
              stroke={CHART_COLORS.palette[5]}
              fill={CHART_COLORS.palette[5]}
              fillOpacity={0.2}
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Performance Panel
// ---------------------------------------------------------------------------

function LatencyChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Latency</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis tickFormatter={(v: number) => formatLatency(v)} {...AXIS_CONFIG} />
            <Tooltip content={<ChartTooltip formatter={(v) => formatLatency(v)} />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="avg_latency_ms"
              name="Avg"
              stroke={CHART_COLORS.primary}
              strokeWidth={2}
              dot={false}
              {...ANIMATION_PROPS}
            />
            <Line
              type="monotone"
              dataKey="p95_latency_ms"
              name="P95"
              stroke={CHART_COLORS.warning}
              strokeWidth={1.5}
              strokeDasharray="4 2"
              dot={false}
              {...ANIMATION_PROPS}
            />
            <Line
              type="monotone"
              dataKey="p99_latency_ms"
              name="P99"
              stroke={CHART_COLORS.danger}
              strokeWidth={1}
              strokeDasharray="2 2"
              dot={false}
              {...ANIMATION_PROPS}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TtftChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  const hasData = data.some((b) => b.avg_ttft_ms != null);
  if (!hasData) return null;

  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Time to First Token</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis tickFormatter={(v: number) => formatLatency(v)} {...AXIS_CONFIG} />
            <Tooltip content={<ChartTooltip formatter={(v) => formatLatency(v)} />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="avg_ttft_ms"
              name="Avg TTFT"
              stroke={CHART_COLORS.palette[3]}
              strokeWidth={2}
              dot={false}
              connectNulls
              {...ANIMATION_PROPS}
            />
            <Line
              type="monotone"
              dataKey="p95_ttft_ms"
              name="P95 TTFT"
              stroke={CHART_COLORS.palette[7]}
              strokeWidth={1.5}
              strokeDasharray="4 2"
              dot={false}
              connectNulls
              {...ANIMATION_PROPS}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reliability Panel
// ---------------------------------------------------------------------------

function ErrorRateChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  const withRate = data.map((b) => ({
    ...b,
    error_rate_pct: b.count > 0 ? (b.error_count / b.count) * 100 : 0,
  }));

  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Error Rate</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={withRate}>
            <defs>
              <linearGradient id="errorRateFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.danger} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.danger} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...AXIS_CONFIG} />
            <Tooltip content={<ChartTooltip formatter={(v) => `${v.toFixed(1)}%`} />} />
            <Area
              type="monotone"
              dataKey="error_rate_pct"
              name="Error Rate"
              stroke={CHART_COLORS.danger}
              fill="url(#errorRateFill)"
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage Panel
// ---------------------------------------------------------------------------

function TokenBurnChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Token Usage</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
            <YAxis tickFormatter={(v: number) => formatCompact(v)} {...AXIS_CONFIG} />
            <Tooltip content={<ChartTooltip formatter={(v) => formatCompact(v)} />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="input_tokens"
              name="Input"
              stackId="tokens"
              stroke={CHART_COLORS.palette[8]}
              fill={CHART_COLORS.palette[8]}
              fillOpacity={0.2}
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
            <Area
              type="monotone"
              dataKey="output_tokens"
              name="Output"
              stackId="tokens"
              stroke={CHART_COLORS.palette[4]}
              fill={CHART_COLORS.palette[4]}
              fillOpacity={0.2}
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdown Bar (quick horizontal bars)
// ---------------------------------------------------------------------------

function BreakdownBar({ title, data, limit = 5 }: { title: string; data: BreakdownEntry[]; limit?: number }) {
  const top = data.slice(0, limit);
  const maxCount = top.length > 0 ? Math.max(...top.map((e) => e.count)) : 1;

  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">{title}</h3>
      <div className="space-y-2">
        {top.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-24 truncate shrink-0">{entry.key || "(empty)"}</span>
            <div className="flex-1 h-5 bg-muted rounded-sm overflow-hidden">
              <div
                className="h-full bg-primary/60 rounded-sm transition-all"
                style={{ width: `${(entry.count / maxCount) * 100}%` }}
              />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground w-12 text-right">{formatCompact(entry.count)}</span>
          </div>
        ))}
        {top.length === 0 && (
          <p className="text-xs text-muted-foreground">No data</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface AnalyticsChartsProps {
  timeseries: ExtendedTimeseriesBucket[];
  modelBreakdown?: BreakdownEntry[];
  clientBreakdown?: BreakdownEntry[];
  strategyBreakdown?: BreakdownEntry[];
}

export function AnalyticsCharts({
  timeseries,
  modelBreakdown = [],
  clientBreakdown = [],
  strategyBreakdown = [],
}: AnalyticsChartsProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartSkeleton />
          <ChartSkeleton />
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Traffic */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Traffic</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <TrafficVolumeChart data={timeseries} />
          <StreamSyncChart data={timeseries} />
        </div>
      </section>

      {/* Performance */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Performance</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <LatencyChart data={timeseries} />
          <TtftChart data={timeseries} />
        </div>
      </section>

      {/* Reliability */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Reliability</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ErrorRateChart data={timeseries} />
          <TokenBurnChart data={timeseries} />
        </div>
      </section>

      {/* Quick Breakdowns */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Breakdowns</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <BreakdownBar title="Top Models" data={modelBreakdown} />
          <BreakdownBar title="Top Clients" data={clientBreakdown} />
          <BreakdownBar title="Top Strategies" data={strategyBreakdown} />
        </div>
      </section>
    </div>
  );
}
