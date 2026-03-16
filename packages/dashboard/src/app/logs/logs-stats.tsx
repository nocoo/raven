"use client";

import { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  ChevronDown,
  ChevronUp,
  Activity,
  AlertTriangle,
  Timer,
  Coins,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CHART_COLORS,
  AXIS_CONFIG,
  TOOLTIP_STYLES,
  RESPONSIVE_CONTAINER_PROPS,
  formatCompact,
  formatLatency as fmtLatency,
  getChartColor,
} from "@/lib/chart-config";
import type { LogEvent } from "@/hooks/use-log-stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogsStatsProps {
  events: LogEvent[];
}

interface RequestEndData {
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: string;
}

interface MinuteBucket {
  minute: number; // floored to minute (ms)
  count: number;
  errors: number;
}

interface ModelCount {
  model: string;
  count: number;
}

interface LatencyPoint {
  index: number;
  latencyMs: number;
  model: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function extractRequestEnds(events: LogEvent[]): RequestEndData[] {
  const results: RequestEndData[] = [];
  for (const e of events) {
    if (e.type !== "request_end") continue;
    const d = e.data;
    if (!d) continue;
    results.push({
      ts: e.ts,
      model: (d.model as string) ?? "unknown",
      inputTokens: (d.inputTokens as number) ?? 0,
      outputTokens: (d.outputTokens as number) ?? 0,
      latencyMs: (d.latencyMs as number) ?? 0,
      status: (d.status as string) ?? "unknown",
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Aggregation hooks (via useMemo)
// ---------------------------------------------------------------------------

function useStats(events: LogEvent[]) {
  return useMemo(() => {
    const ends = extractRequestEnds(events);
    const total = ends.length;
    const errors = ends.filter((e) => e.status === "error").length;
    const errorRate = total > 0 ? errors / total : 0;
    const avgLatency =
      total > 0
        ? ends.reduce((s, e) => s + e.latencyMs, 0) / total
        : 0;
    const totalTokens = ends.reduce(
      (s, e) => s + e.inputTokens + e.outputTokens,
      0,
    );
    const totalInput = ends.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutput = ends.reduce((s, e) => s + e.outputTokens, 0);

    return {
      total,
      errors,
      errorRate,
      avgLatency,
      totalTokens,
      totalInput,
      totalOutput,
    };
  }, [events]);
}

function useMinuteBuckets(events: LogEvent[]): MinuteBucket[] {
  return useMemo(() => {
    const ends = extractRequestEnds(events);
    if (ends.length === 0) return [];

    const bucketMap = new Map<number, MinuteBucket>();
    for (const e of ends) {
      const minute = Math.floor(e.ts / 60_000) * 60_000;
      const existing = bucketMap.get(minute);
      if (existing) {
        existing.count++;
        if (e.status === "error") existing.errors++;
      } else {
        bucketMap.set(minute, {
          minute,
          count: 1,
          errors: e.status === "error" ? 1 : 0,
        });
      }
    }

    // Sort by time, keep last 30 minutes max
    const sorted = [...bucketMap.values()].sort((a, b) => a.minute - b.minute);
    return sorted.slice(-30);
  }, [events]);
}

function useModelDistribution(events: LogEvent[]): ModelCount[] {
  return useMemo(() => {
    const ends = extractRequestEnds(events);
    const counts = new Map<string, number>();
    for (const e of ends) {
      counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // top 10 models
  }, [events]);
}

function useLatencyPoints(events: LogEvent[]): LatencyPoint[] {
  return useMemo(() => {
    const ends = extractRequestEnds(events);
    // Last 50 requests for the scatter/line
    return ends.slice(-50).map((e, i) => ({
      index: i,
      latencyMs: e.latencyMs,
      model: e.model,
      ts: e.ts,
    }));
  }, [events]);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatMinute(minute: number): string {
  const d = new Date(minute);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string | undefined;
  accent?: "default" | "danger" | "warning" | "success" | undefined;
}) {
  const accentColor = {
    default: "text-foreground",
    danger: "text-red-500",
    warning: "text-amber-500",
    success: "text-green-500",
  }[accent ?? "default"];

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground truncate">{label}</p>
        <p className={cn("text-lg font-semibold leading-tight tabular-nums", accentColor)}>
          {value}
        </p>
        {sub && (
          <p className="text-[10px] text-muted-foreground truncate">{sub}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart tooltips
// ---------------------------------------------------------------------------

function RpmTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const count = payload.find((p) => p.dataKey === "count");
  const errors = payload.find((p) => p.dataKey === "errors");
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>
        {label ? formatMinute(label) : ""}
      </p>
      <p className={TOOLTIP_STYLES.value}>
        {count?.value ?? 0} requests
      </p>
      {(errors?.value ?? 0) > 0 && (
        <p className="text-red-500 text-xs">{errors?.value} errors</p>
      )}
    </div>
  );
}

function ModelTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ModelCount }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{d.model}</p>
      <p className={TOOLTIP_STYLES.value}>{d.count} requests</p>
    </div>
  );
}

function LatencyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: LatencyPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{d.model}</p>
      <p className={TOOLTIP_STYLES.value}>{fmtLatency(d.latencyMs)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LogsStats({ events }: LogsStatsProps) {
  const [expanded, setExpanded] = useState(true);
  const stats = useStats(events);
  const minuteBuckets = useMinuteBuckets(events);
  const modelDist = useModelDistribution(events);
  const latencyPoints = useLatencyPoints(events);

  const hasData = stats.total > 0;

  return (
    <div className="shrink-0 rounded-lg border bg-card overflow-hidden">
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium hover:bg-muted/50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          Session Stats
          {hasData && (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              — {stats.total} requests
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-4">
          {/* ── Stat cards ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatCard
              icon={Activity}
              label="Total Requests"
              value={formatCompact(stats.total)}
              sub={stats.errors > 0 ? `${stats.errors} failed` : undefined}
            />
            <StatCard
              icon={AlertTriangle}
              label="Error Rate"
              value={hasData ? formatPercent(stats.errorRate) : "—"}
              accent={
                stats.errorRate > 0.1
                  ? "danger"
                  : stats.errorRate > 0
                    ? "warning"
                    : "success"
              }
            />
            <StatCard
              icon={Timer}
              label="Avg Latency"
              value={hasData ? fmtLatency(stats.avgLatency) : "—"}
              accent={
                stats.avgLatency > 10_000
                  ? "danger"
                  : stats.avgLatency > 5_000
                    ? "warning"
                    : "default"
              }
            />
            <StatCard
              icon={Coins}
              label="Total Tokens"
              value={hasData ? formatCompact(stats.totalTokens) : "—"}
              sub={
                hasData
                  ? `in ${formatCompact(stats.totalInput)} · out ${formatCompact(stats.totalOutput)}`
                  : undefined
              }
            />
          </div>

          {/* ── Charts (only render when we have data) ── */}
          {hasData && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* Requests per minute */}
              {minuteBuckets.length > 1 && (
                <div className="bg-secondary rounded-lg p-3">
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">
                    Requests / min
                  </h4>
                  <div className="h-[160px]">
                    <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
                      <AreaChart data={minuteBuckets}>
                        <defs>
                          <linearGradient
                            id="logRpmFill"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="5%"
                              stopColor={CHART_COLORS.primary}
                              stopOpacity={0.3}
                            />
                            <stop
                              offset="95%"
                              stopColor={CHART_COLORS.primary}
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          strokeOpacity={0.3}
                        />
                        <XAxis
                          dataKey="minute"
                          tickFormatter={formatMinute}
                          {...AXIS_CONFIG}
                        />
                        <YAxis
                          allowDecimals={false}
                          {...AXIS_CONFIG}
                        />
                        <Tooltip content={<RpmTooltip />} />
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke={CHART_COLORS.primary}
                          fill="url(#logRpmFill)"
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Model distribution */}
              {modelDist.length > 0 && (
                <div className="bg-secondary rounded-lg p-3">
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">
                    Model Distribution
                  </h4>
                  <div className="h-[160px]">
                    <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
                      <BarChart
                        data={modelDist}
                        layout="vertical"
                        margin={{ left: 0, right: 12, top: 4, bottom: 4 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          strokeOpacity={0.3}
                          horizontal={false}
                        />
                        <XAxis type="number" allowDecimals={false} {...AXIS_CONFIG} />
                        <YAxis
                          type="category"
                          dataKey="model"
                          width={120}
                          {...AXIS_CONFIG}
                          tick={{ fontSize: 11, fill: AXIS_CONFIG.tick.fill }}
                        />
                        <Tooltip content={<ModelTooltip />} />
                        <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={24}>
                          {modelDist.map((_, i) => (
                            <Cell key={i} fill={getChartColor(i)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Latency trend */}
              {latencyPoints.length > 1 && (
                <div className="bg-secondary rounded-lg p-3 lg:col-span-2">
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">
                    Latency Trend
                    <span className="ml-2 font-normal text-muted-foreground/60">
                      (last {latencyPoints.length} requests)
                    </span>
                  </h4>
                  <div className="h-[160px]">
                    <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
                      <LineChart data={latencyPoints}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          strokeOpacity={0.3}
                        />
                        <XAxis
                          dataKey="index"
                          {...AXIS_CONFIG}
                          tick={false}
                        />
                        <YAxis
                          tickFormatter={(v: number) => fmtLatency(v)}
                          {...AXIS_CONFIG}
                        />
                        <Tooltip content={<LatencyTooltip />} />
                        <Line
                          type="monotone"
                          dataKey="latencyMs"
                          stroke={CHART_COLORS.warning}
                          strokeWidth={2}
                          dot={{ r: 2, fill: CHART_COLORS.warning }}
                          activeDot={{ r: 4 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!hasData && (
            <div className="flex items-center justify-center rounded-md border border-dashed py-6 text-xs text-muted-foreground">
              Stats will appear as requests complete
            </div>
          )}
        </div>
      )}
    </div>
  );
}
