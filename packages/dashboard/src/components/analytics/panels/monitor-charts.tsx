"use client";

import { useRouter } from "next/navigation";
import { Area, AreaChart, Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip, ChartTooltipRow, DashboardCartesianGrid } from "@/components/dashboard/chart-primitives";
import { ANIMATION_PROPS, AXIS_CONFIG, CHART_COLORS, formatCompact, formatLatency, getChartColor, RESPONSIVE_CONTAINER_PROPS } from "@/lib/chart-config";
import { bucketHref, chartActivity, fillActivity, formatAxisTime, formatMonitorTime, keyLabel, monitorHref, trafficSeries, type UsageDimension } from "@/lib/monitor";
import type { MonitorData } from "@/lib/monitor-data";
import { MonitorLink, MonitorPanel } from "./monitor-panels";

interface TooltipPayload { name?: string | undefined; value?: number | string | (string | number)[] | undefined; color?: string | undefined; dataKey?: string | number | undefined }

function TimelineTooltip({ active, payload, label }: { active?: boolean | undefined; payload?: readonly TooltipPayload[] | undefined; label?: string | number | undefined }) {
  if (!active || !payload?.length) return null;
  return <ChartTooltip title={`${formatMonitorTime(Number(label))} UTC`}>{payload.map(item => <ChartTooltipRow key={String(item.dataKey)} {...(item.color ? { color: item.color } : {})} label={item.name} value={String(item.dataKey).endsWith("_ms") ? formatLatency(Number(item.value)) : formatCompact(Number(item.value))} />)}</ChartTooltip>;
}

function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-basalt-muted-foreground">{items.map(item => <span key={item.label} className="flex min-w-0 items-center gap-1.5"><span className="size-2 shrink-0 rounded-sm" style={{ background: item.color }} /><span className="max-w-56 truncate" title={item.label}>{item.label}</span></span>)}</div>;
}

export function TrafficChart({ data }: { data: MonitorData }) {
  const router = useRouter();
  const points = trafficSeries(data.timeseries, data.window, data.intervalMs);
  return <MonitorPanel title="Traffic & response time" description="Request outcomes with P95 latency and time to first token." action={<MonitorLink href={monitorHref("/requests", data.filters)}>Requests</MonitorLink>}>
    <ChartLegend items={[{ label: "Success", color: CHART_COLORS.primary }, { label: "Errors", color: CHART_COLORS.danger }, { label: "P95 latency", color: CHART_COLORS.warning }, { label: "Avg TTFT", color: CHART_COLORS.success }]} />
    <div className="h-56 min-w-0">
      <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
        <ComposedChart data={points} margin={{ top: 8, right: 0, left: -18, bottom: 0 }} onClick={state => { if (state.activeLabel !== undefined) router.push(bucketHref(data.filters, Number(state.activeLabel), data.intervalMs, data.window)); }}>
          <DashboardCartesianGrid />
          <XAxis dataKey="bucket" {...AXIS_CONFIG} minTickGap={38} tickFormatter={value => formatAxisTime(Number(value), data.window.to - data.window.from)} />
          <YAxis yAxisId="count" {...AXIS_CONFIG} allowDecimals={false} tickFormatter={formatCompact} />
          <YAxis yAxisId="latency" orientation="right" {...AXIS_CONFIG} tickFormatter={formatLatency} width={64} />
          <Tooltip content={<TimelineTooltip />} />
          <Bar {...ANIMATION_PROPS} yAxisId="count" dataKey="success_count" name="Success" stackId="outcome" fill={CHART_COLORS.primary} maxBarSize={28} />
          <Bar {...ANIMATION_PROPS} yAxisId="count" dataKey="error_count" name="Errors" stackId="outcome" fill={CHART_COLORS.danger} maxBarSize={28} />
          <Line {...ANIMATION_PROPS} yAxisId="latency" dataKey="p95_latency_ms" name="P95 latency" stroke={CHART_COLORS.warning} strokeWidth={2} dot={false} connectNulls={false} />
          <Line {...ANIMATION_PROPS} yAxisId="latency" dataKey="avg_ttft_ms" name="Avg TTFT" stroke={CHART_COLORS.success} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <p className="mt-2 text-xs text-basalt-muted-foreground">Click a time bucket to inspect its requests · UTC · empty intervals have no latency sample</p>
  </MonitorPanel>;
}

export function TokenChart({ data }: { data: MonitorData }) {
  const router = useRouter();
  const points = trafficSeries(data.timeseries, data.window, data.intervalMs);
  const series = [
    { key: "input_tokens", label: "Uncached input", color: CHART_COLORS.primary },
    { key: "output_tokens", label: "Output", color: getChartColor(1) },
    { key: "cache_read_tokens", label: "Cache read", color: CHART_COLORS.success },
    { key: "cache_write_tokens", label: "Cache write", color: CHART_COLORS.warning },
  ];
  return <MonitorPanel title="Token composition" description="Input, output and cache counters reported by the upstream.">
    <ChartLegend items={series} />
    <div className="h-48 min-w-0"><ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}><ComposedChart data={points} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} onClick={state => { if (state.activeLabel !== undefined) router.push(bucketHref(data.filters, Number(state.activeLabel), data.intervalMs, data.window)); }}>
      <DashboardCartesianGrid /><XAxis dataKey="bucket" {...AXIS_CONFIG} minTickGap={38} tickFormatter={value => formatAxisTime(Number(value), data.window.to - data.window.from)} /><YAxis {...AXIS_CONFIG} tickFormatter={formatCompact} /><Tooltip content={<TimelineTooltip />} />
      {series.map(item => <Bar {...ANIMATION_PROPS} key={item.key} dataKey={item.key} name={item.label} fill={item.color} stackId="tokens" maxBarSize={28} />)}
    </ComposedChart></ResponsiveContainer></div>
    <p className="mt-2 text-xs text-basalt-muted-foreground">Cache counters are shown separately from input + output; they are not a billing estimate.</p>
  </MonitorPanel>;
}

export function ActivityChart({ data, dimension }: { data: MonitorData; dimension: UsageDimension }) {
  const router = useRouter();
  const labels = dimension === "key_id" ? Object.fromEntries(data.keys.map(entry => [entry.key, `${keyLabel(entry)} · ${entry.key.startsWith("legacy:") ? "historical" : entry.key.slice(-8)}`])) : {};
  const grouped = chartActivity(fillActivity(data.activity, data.window.from, data.window.to, data.intervalMs), labels);
  return <MonitorPanel title={dimension === "key_id" ? "Key activity over time" : "Model workload over time"} description="Requests per time bucket. Click a bucket to trace the calls." action={<MonitorLink href={monitorHref("/requests", data.filters)}>Trace requests</MonitorLink>}>
    <ChartLegend items={grouped.series.map((item, index) => ({ label: item.label, color: getChartColor(index) }))} />
    <div className="h-56 min-w-0"><ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}><AreaChart data={grouped.points} margin={{ top: 8, right: 4, left: -18, bottom: 0 }} onClick={state => { if (state.activeLabel !== undefined) router.push(bucketHref(data.filters, Number(state.activeLabel), data.intervalMs, data.window)); }}>
      <DashboardCartesianGrid /><XAxis dataKey="bucket" {...AXIS_CONFIG} minTickGap={38} tickFormatter={value => formatAxisTime(Number(value), data.window.to - data.window.from)} /><YAxis {...AXIS_CONFIG} allowDecimals={false} tickFormatter={formatCompact} /><Tooltip content={<TimelineTooltip />} />
      {grouped.series.map((item, index) => <Area {...ANIMATION_PROPS} key={item.id} dataKey={item.id} name={item.label} type="stepAfter" stroke={getChartColor(index)} fill={getChartColor(index)} fillOpacity={0.35} stackId="requests" />)}
    </AreaChart></ResponsiveContainer></div>
    <p className="mt-2 text-xs text-basalt-muted-foreground">{formatMonitorTime(data.window.from)} – {formatMonitorTime(data.window.to)} UTC · top series and Others</p>
  </MonitorPanel>;
}
