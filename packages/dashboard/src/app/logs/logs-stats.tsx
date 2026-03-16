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
  minute: number;
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
// Aggregation (useMemo)
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

    return { total, errors, errorRate, avgLatency, totalTokens, totalInput, totalOutput };
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
    return [...bucketMap.values()].sort((a, b) => a.minute - b.minute).slice(-30);
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
      .slice(0, 8);
  }, [events]);
}

function useLatencyPoints(events: LogEvent[]): LatencyPoint[] {
  return useMemo(() => {
    const ends = extractRequestEnds(events);
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
// Stat Card — compact for sidebar
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
    <div className="flex items-center gap-2.5 rounded-lg border bg-card p-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground truncate">{label}</p>
        <p className={cn("text-base font-semibold leading-tight tabular-nums", accentColor)}>
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
      <p className={TOOLTIP_STYLES.title}>{label ? formatMinute(label) : ""}</p>
      <p className={TOOLTIP_STYLES.value}>{count?.value ?? 0} requests</p>
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
// Chart sections (shared between desktop & mobile)
// ---------------------------------------------------------------------------

function StatsCards({ stats, hasData }: {
  stats: ReturnType<typeof useStats>;
  hasData: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatCard
        icon={Activity}
        label="Requests"
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
        label="Tokens"
        value={hasData ? formatCompact(stats.totalTokens) : "—"}
        sub={
          hasData
            ? `in ${formatCompact(stats.totalInput)} · out ${formatCompact(stats.totalOutput)}`
            : undefined
        }
      />
    </div>
  );
}

function ChartRpm({ data }: { data: MinuteBucket[] }) {
  if (data.length < 2) return null;
  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Requests / min
      </h4>
      <div className="h-[140px]">
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="logRpmFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="minute" tickFormatter={formatMinute} {...AXIS_CONFIG} />
            <YAxis allowDecimals={false} {...AXIS_CONFIG} width={30} />
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
  );
}

function ChartModels({ data }: { data: ModelCount[] }) {
  if (data.length === 0) return null;
  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Models
      </h4>
      <div className="h-[140px]">
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 0, right: 8, top: 4, bottom: 4 }}
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
              width={90}
              {...AXIS_CONFIG}
              tick={{ fontSize: 10, fill: AXIS_CONFIG.tick.fill }}
            />
            <Tooltip content={<ModelTooltip />} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20}>
              {data.map((_, i) => (
                <Cell key={i} fill={getChartColor(i)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ChartLatency({ data }: { data: LatencyPoint[] }) {
  if (data.length < 2) return null;
  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Latency
        <span className="ml-1 font-normal text-muted-foreground/60">
          (last {data.length})
        </span>
      </h4>
      <div className="h-[140px]">
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="index" {...AXIS_CONFIG} tick={false} />
            <YAxis tickFormatter={(v: number) => fmtLatency(v)} {...AXIS_CONFIG} width={40} />
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
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LogsStats({ events }: LogsStatsProps) {
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const stats = useStats(events);
  const minuteBuckets = useMinuteBuckets(events);
  const modelDist = useModelDistribution(events);
  const latencyPoints = useLatencyPoints(events);

  const hasData = stats.total > 0;

  return (
    <>
      {/* ── Desktop: fixed-width left sidebar, always visible ── */}
      <div className="hidden lg:flex lg:w-[340px] lg:shrink-0 lg:flex-col lg:gap-3 lg:overflow-y-auto">
        <StatsCards stats={stats} hasData={hasData} />
        {hasData && (
          <>
            <ChartRpm data={minuteBuckets} />
            <ChartModels data={modelDist} />
            <ChartLatency data={latencyPoints} />
          </>
        )}
        {!hasData && (
          <div className="flex items-center justify-center rounded-md border border-dashed py-8 text-xs text-muted-foreground">
            Stats will appear as requests complete
          </div>
        )}
      </div>

      {/* ── Mobile: collapsible strip above stream ── */}
      <div className="lg:hidden shrink-0 rounded-lg border bg-card overflow-hidden">
        <button
          type="button"
          onClick={() => setMobileExpanded(!mobileExpanded)}
          className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            Stats
            {hasData && (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {stats.total} req · {hasData ? fmtLatency(stats.avgLatency) : "—"} avg · {formatCompact(stats.totalTokens)} tok
              </span>
            )}
          </span>
          {mobileExpanded ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>

        {mobileExpanded && (
          <div className="border-t px-3 pb-3 pt-2 space-y-3">
            <StatsCards stats={stats} hasData={hasData} />
            {hasData && (
              <>
                <ChartRpm data={minuteBuckets} />
                <ChartModels data={modelDist} />
                <ChartLatency data={latencyPoints} />
              </>
            )}
            {!hasData && (
              <div className="flex items-center justify-center rounded-md border border-dashed py-6 text-xs text-muted-foreground">
                Stats will appear as requests complete
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
