"use client";

import { useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CHART_COLORS,
  AXIS_CONFIG,
  RESPONSIVE_CONTAINER_PROPS,
  CHART_HEIGHTS,
  ANIMATION_PROPS,
  formatBucketTime,
  formatCompact,
  formatLatency,
} from "@/lib/chart-config";
import {
  ChartTooltip,
  ChartTooltipRow,
  ChartTooltipSummary,
  DashboardCartesianGrid,
} from "@/components/dashboard/chart-primitives";
import { DashboardSegment } from "@/components/layout/dashboard-segment";
import type { ExtendedTimeseriesBucket, BreakdownEntry } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared tooltip — uses chart-primitives atoms (Rule 6)
// ---------------------------------------------------------------------------

function TimeseriesTooltip({
  active,
  payload,
  label,
  formatter,
  showTotal = false,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
  formatter?: (value: number, name: string) => string;
  showTotal?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const fmt = formatter ?? ((v: number) => v.toLocaleString());
  const total = showTotal ? payload.reduce((s, e) => s + e.value, 0) : 0;
  return (
    <ChartTooltip title={label ? formatBucketTime(label) : undefined}>
      {payload.map((entry) => (
        <ChartTooltipRow
          key={entry.name}
          color={entry.color}
          label={entry.name}
          value={fmt(entry.value, entry.name)}
        />
      ))}
      {showTotal && payload.length > 1 && (
        <ChartTooltipSummary label="Total" value={fmt(total, "total")} />
      )}
    </ChartTooltip>
  );
}

// ---------------------------------------------------------------------------
// Skeleton (L2 surface inside the section card)
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  const height = CHART_HEIGHTS.standard + 48;
  return (
    <div className="bg-secondary rounded-card p-3 md:p-4" style={{ height }}>
      <Skeleton className="h-4 w-32 mb-3" />
      <Skeleton className="h-full w-full rounded-widget" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper — uppercase label + hairline (DashboardSegment), no outer
// card surface. Children are L2 ChartPanel atoms which carry their own bg.
// ---------------------------------------------------------------------------

function ChartSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <DashboardSegment title={title}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        {children}
      </div>
    </DashboardSegment>
  );
}

// ---------------------------------------------------------------------------
// Chart panel wrapper — L2 surface inside a section
// ---------------------------------------------------------------------------

function ChartPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-secondary rounded-card p-3 md:p-4">
      <h3 className="text-card-label mb-3 font-medium">{title}</h3>
      <div style={{ height: CHART_HEIGHTS.standard }}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traffic Panel
// ---------------------------------------------------------------------------

function TrafficVolumeChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <ChartPanel title="Request Volume">
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
        <DashboardCartesianGrid />
        <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
        <YAxis {...AXIS_CONFIG} />
        <Tooltip content={<TimeseriesTooltip showTotal />} />
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
    </ChartPanel>
  );
}

function StreamSyncChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <ChartPanel title="Stream vs Sync">
      <AreaChart data={data}>
        <DashboardCartesianGrid />
        <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
        <YAxis {...AXIS_CONFIG} />
        <Tooltip content={<TimeseriesTooltip showTotal />} />
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
    </ChartPanel>
  );
}

// ---------------------------------------------------------------------------
// Performance Panel
// ---------------------------------------------------------------------------

function LatencyChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <ChartPanel title="Latency">
      <LineChart data={data}>
        <DashboardCartesianGrid />
        <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
        <YAxis tickFormatter={(v: number) => formatLatency(v)} {...AXIS_CONFIG} />
        <Tooltip content={<TimeseriesTooltip formatter={(v) => formatLatency(v)} />} />
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
    </ChartPanel>
  );
}

function TtftChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  const hasData = data.some((b) => b.avg_ttft_ms != null);
  if (!hasData) return null;

  return (
    <ChartPanel title="Time to First Token">
      <LineChart data={data}>
        <DashboardCartesianGrid />
        <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
        <YAxis tickFormatter={(v: number) => formatLatency(v)} {...AXIS_CONFIG} />
        <Tooltip content={<TimeseriesTooltip formatter={(v) => formatLatency(v)} />} />
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
    </ChartPanel>
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
    <ChartPanel title="Error Rate">
      <AreaChart data={withRate}>
        <defs>
          <linearGradient id="errorRateFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.danger} stopOpacity={0.3} />
            <stop offset="95%" stopColor={CHART_COLORS.danger} stopOpacity={0} />
          </linearGradient>
        </defs>
        <DashboardCartesianGrid />
        <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
        <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...AXIS_CONFIG} />
        <Tooltip content={<TimeseriesTooltip formatter={(v) => `${v.toFixed(1)}%`} />} />
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
    </ChartPanel>
  );
}

// ---------------------------------------------------------------------------
// Usage Panel
// ---------------------------------------------------------------------------

function TokenBurnChart({ data }: { data: ExtendedTimeseriesBucket[] }) {
  return (
    <ChartPanel title="Token Usage">
      <AreaChart data={data}>
        <DashboardCartesianGrid />
        <XAxis dataKey="bucket" tickFormatter={formatBucketTime} {...AXIS_CONFIG} />
        <YAxis tickFormatter={(v: number) => formatCompact(v)} {...AXIS_CONFIG} />
        <Tooltip content={<TimeseriesTooltip formatter={(v) => formatCompact(v)} showTotal />} />
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
    </ChartPanel>
  );
}

// ---------------------------------------------------------------------------
// Breakdown Bar (quick horizontal bars) — L2 surface inside section
// ---------------------------------------------------------------------------

function BreakdownBar({ title, data, limit = 5 }: { title: string; data: BreakdownEntry[]; limit?: number }) {
  const top = data.slice(0, limit);
  const maxCount = top.length > 0 ? Math.max(...top.map((e) => e.count)) : 1;

  return (
    <div className="bg-secondary rounded-card p-3 md:p-4">
      <h3 className="text-card-label mb-3 font-medium">{title}</h3>
      <div className="space-y-2">
        {top.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2">
            <span className="text-meta w-24 truncate shrink-0">{entry.key || "(empty)"}</span>
            <div className="flex-1 h-5 bg-muted rounded-sm overflow-hidden">
              <div
                className="h-full bg-primary/60 rounded-sm transition-all"
                style={{ width: `${(entry.count / maxCount) * 100}%` }}
              />
            </div>
            <span className="text-numeric w-12 text-right text-muted-foreground">
              {formatCompact(entry.count)}
            </span>
          </div>
        ))}
        {top.length === 0 && (
          <p className="text-meta">No data</p>
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
      <div className="space-y-5 md:space-y-7">
        <DashboardSegment title="Traffic">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
        </DashboardSegment>
        <DashboardSegment title="Performance">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
        </DashboardSegment>
      </div>
    );
  }

  return (
    <div className="space-y-5 md:space-y-7">
      <ChartSection title="Traffic">
        <TrafficVolumeChart data={timeseries} />
        <StreamSyncChart data={timeseries} />
      </ChartSection>

      <ChartSection title="Performance">
        <LatencyChart data={timeseries} />
        <TtftChart data={timeseries} />
      </ChartSection>

      <ChartSection title="Reliability">
        <ErrorRateChart data={timeseries} />
        <TokenBurnChart data={timeseries} />
      </ChartSection>

      <DashboardSegment title="Breakdowns">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
          <BreakdownBar title="Top Models" data={modelBreakdown} />
          <BreakdownBar title="Top Clients" data={clientBreakdown} />
          <BreakdownBar title="Top Strategies" data={strategyBreakdown} />
        </div>
      </DashboardSegment>
    </div>
  );
}
