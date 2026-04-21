"use client";

import { useEffect, useMemo, useState } from "react";
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
  Users,
  Circle,
  Zap,
} from "lucide-react";
import {
  CHART_COLORS,
  AXIS_CONFIG,
  TOOLTIP_STYLES,
  RESPONSIVE_CONTAINER_PROPS,
  CHART_HEIGHTS,
  ANIMATION_PROPS,
  formatCompact,
  formatLatency as fmtLatency,
  getChartColor,
} from "@/lib/chart-config";
import { StatCard } from "@/components/stats/stat-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
  ttftMs: number | null;
  processingMs: number | null;
  stream: boolean;
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

interface TimingPoint {
  index: number;
  latencyMs: number;
  ttftMs: number | null;
  processingMs: number | null;
  model: string;
  stream: boolean;
  ts: number;
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

export function extractRequestEnds(events: LogEvent[]): RequestEndData[] {
  const results: RequestEndData[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== "request_end") continue;
    // Dedup by requestId — SSE reconnect replays ring buffer backfill
    if (e.requestId) {
      if (seen.has(e.requestId)) continue;
      seen.add(e.requestId);
    }
    const d = e.data;
    if (!d) continue;
    results.push({
      ts: e.ts,
      model: (d.model as string) ?? "unknown",
      inputTokens: (d.inputTokens as number) ?? 0,
      outputTokens: (d.outputTokens as number) ?? 0,
      latencyMs: (d.latencyMs as number) ?? 0,
      ttftMs: (d.ttftMs as number) ?? null,
      processingMs: (d.processingMs as number) ?? null,
      stream: !!(d.stream),
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

    // TTFT — only from entries that have it (streaming requests)
    const withTtft = ends.filter((e) => e.ttftMs !== null);
    const avgTtft = withTtft.length > 0
      ? withTtft.reduce((s, e) => s + e.ttftMs!, 0) / withTtft.length
      : 0;

    // Processing — only from entries that have it
    const withProcessing = ends.filter((e) => e.processingMs !== null);
    const avgProcessing = withProcessing.length > 0
      ? withProcessing.reduce((s, e) => s + e.processingMs!, 0) / withProcessing.length
      : 0;

    return {
      total, errors, errorRate, avgLatency, totalTokens, totalInput, totalOutput,
      avgTtft, ttftCount: withTtft.length,
      avgProcessing, processingCount: withProcessing.length,
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

function useTimingPoints(events: LogEvent[]): TimingPoint[] {
  return useMemo(() => {
    const ends = extractRequestEnds(events);
    return ends.slice(-50).map((e, i) => ({
      index: i,
      latencyMs: e.latencyMs,
      ttftMs: e.ttftMs,
      processingMs: e.processingMs,
      model: e.model,
      stream: e.stream,
      ts: e.ts,
    }));
  }, [events]);
}

// ---------------------------------------------------------------------------
// Session tracking types
// ---------------------------------------------------------------------------

interface SessionInfo {
  sessionId: string;
  clientName: string;
  clientVersion: string | null;
  accountName: string;
  activeRequests: Set<string>;
  totalRequests: number;
  errorCount: number;
  totalTokens: number;
  lastActiveTs: number;
  firstSeenTs: number;
}

interface ConcurrencyPoint {
  minute: number;
  sessions: number;
}

// ---------------------------------------------------------------------------
// Reconnect replay dedup
// ---------------------------------------------------------------------------

export function dedupEvents(events: LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  const result: LogEvent[] = [];
  for (const e of events) {
    if (!e.requestId) {
      result.push(e);
      continue;
    }
    const key = `${e.requestId}:${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(e);
  }
  return result.sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------------------
// Session aggregation hooks
// ---------------------------------------------------------------------------

export function computeSessionTracker(events: LogEvent[]) {
  const deduped = dedupEvents(events);
  const sessions = new Map<string, SessionInfo>();

  for (const e of deduped) {
    if (e.type === "request_start") {
      const d = e.data ?? {};
      const sessionId = (d.sessionId as string) || "unknown";
      const clientName = (d.clientName as string) || "Unknown";
      const clientVersion = (d.clientVersion as string) ?? null;
      const accountName = (d.accountName as string) || "default";

      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          sessionId,
          clientName,
          clientVersion,
          accountName,
          activeRequests: new Set(),
          totalRequests: 0,
          errorCount: 0,
          totalTokens: 0,
          lastActiveTs: e.ts,
          firstSeenTs: e.ts,
        };
        sessions.set(sessionId, session);
      }

      if (e.requestId) {
        session.activeRequests.add(e.requestId);
      }
      session.lastActiveTs = Math.max(session.lastActiveTs, e.ts);
    }

    if (e.type === "request_end") {
      const d = e.data ?? {};
      const sessionId = (d.sessionId as string) || "unknown";
      const clientName = (d.clientName as string) || "Unknown";
      const clientVersion = (d.clientVersion as string) ?? null;
      const accountName = (d.accountName as string) || "default";

      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          sessionId,
          clientName,
          clientVersion,
          accountName,
          activeRequests: new Set(),
          totalRequests: 0,
          errorCount: 0,
          totalTokens: 0,
          lastActiveTs: e.ts,
          firstSeenTs: e.ts,
        };
        sessions.set(sessionId, session);
      }

      if (e.requestId) {
        session.activeRequests.delete(e.requestId);
      }
      session.totalRequests++;
      session.lastActiveTs = Math.max(session.lastActiveTs, e.ts);

      if ((d.status as string) === "error") session.errorCount++;

      const input = (d.inputTokens as number) ?? 0;
      const output = (d.outputTokens as number) ?? 0;
      session.totalTokens += input + output;
    }
  }

  const allSessions = [...sessions.values()].sort(
    (a, b) => b.lastActiveTs - a.lastActiveTs,
  );
  const activeSessions = allSessions.filter(
    (s) => s.activeRequests.size > 0,
  );
  const totalActiveRequests = activeSessions.reduce(
    (sum, s) => sum + s.activeRequests.size,
    0,
  );

  return {
    sessions: allSessions,
    activeSessions,
    activeCount: activeSessions.length,
    totalActiveRequests,
  };
}

export function useSessionTracker(events: LogEvent[]) {
  return useMemo(() => computeSessionTracker(events), [events]);
}

export function computeConcurrencyTimeline(events: LogEvent[]): ConcurrencyPoint[] {
  const deduped = dedupEvents(events);
  const intervals = new Map<
    string,
    { sessionId: string; startTs: number; endTs: number | null }
  >();

  for (const e of deduped) {
    if (e.type === "request_start" && e.requestId) {
      const sessionId =
        (e.data?.sessionId as string) || "unknown";
      intervals.set(e.requestId, {
        sessionId,
        startTs: e.ts,
        endTs: null,
      });
    }
    if (e.type === "request_end" && e.requestId) {
      const interval = intervals.get(e.requestId);
      if (interval) interval.endTs = e.ts;
    }
  }

  const bucketMap = new Map<number, Set<string>>();
  const now = Date.now();

  for (const { sessionId, startTs, endTs } of intervals.values()) {
    const effectiveEnd = endTs ?? now;
    const startBucket = Math.floor(startTs / 60_000) * 60_000;
    const endBucket = Math.floor(effectiveEnd / 60_000) * 60_000;

    for (let b = startBucket; b <= endBucket; b += 60_000) {
      let set = bucketMap.get(b);
      if (!set) {
        set = new Set();
        bucketMap.set(b, set);
      }
      set.add(sessionId);
    }
  }

  return [...bucketMap.entries()]
    .map(([minute, sessionSet]) => ({ minute, sessions: sessionSet.size }))
    .sort((a, b) => a.minute - b.minute)
    .slice(-30);
}

/**
 * Returns the current minute-aligned timestamp, updating every 60s.
 * Used to force periodic re-computation for time-dependent calculations
 * (e.g. in-progress request timelines that use Date.now()).
 */
function useMinuteTick(): number {
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => {
    // Align to next minute boundary
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    const timeout = setTimeout(() => {
      setTick(Math.floor(Date.now() / 60_000) * 60_000);
      // After first alignment, tick every 60s
      const interval = setInterval(() => {
        setTick(Math.floor(Date.now() / 60_000) * 60_000);
      }, 60_000);
      // Store interval id for cleanup
      cleanupRef = interval;
    }, msToNextMinute);
    let cleanupRef: ReturnType<typeof setInterval> | null = null;
    return () => {
      clearTimeout(timeout);
      if (cleanupRef) clearInterval(cleanupRef);
    };
  }, []);
  return tick;
}

export function useConcurrencyTimeline(events: LogEvent[]): ConcurrencyPoint[] {
  const minuteTick = useMinuteTick();
  // minuteTick forces re-computation every minute so in-progress requests
  // extend their timeline to the current minute even without new events.
  return useMemo(() => computeConcurrencyTimeline(events), [events, minuteTick]);
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

function TimingTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TimingPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>{d.model}</p>
      <p className={TOOLTIP_STYLES.value}>Duration: {fmtLatency(d.latencyMs)}</p>
      {d.ttftMs !== null && (
        <p className={TOOLTIP_STYLES.value}>TTFT: {fmtLatency(d.ttftMs)}</p>
      )}
      {d.processingMs !== null && (
        <p className={TOOLTIP_STYLES.value}>Processing: {fmtLatency(d.processingMs)}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart sections (shared between desktop & mobile)
// ---------------------------------------------------------------------------

function RequestCards({ stats, hasData }: {
  stats: ReturnType<typeof useStats>;
  hasData: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatCard
        variant="compact"
        icon={Activity}
        label="Requests"
        value={formatCompact(stats.total)}
        {...(stats.errors > 0 && { detail: `${stats.errors} failed` })}
      />
      <StatCard
        variant="compact"
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
        variant="compact"
        icon={Zap}
        label="Avg TTFT"
        value={hasData && stats.ttftCount > 0 ? fmtLatency(stats.avgTtft) : "—"}
        {...(hasData && stats.ttftCount > 0 && { detail: `${stats.ttftCount} streaming` })}
        accent={
          stats.avgTtft > 5_000
            ? "danger"
            : stats.avgTtft > 2_000
              ? "warning"
              : "default"
        }
      />
      <StatCard
        variant="compact"
        icon={Timer}
        label="Avg Duration"
        value={hasData ? fmtLatency(stats.avgLatency) : "—"}
        accent={
          stats.avgLatency > 10_000
            ? "danger"
            : stats.avgLatency > 5_000
              ? "warning"
              : "default"
        }
      />
    </div>
  );
}

function ModelCards({ stats, hasData }: {
  stats: ReturnType<typeof useStats>;
  hasData: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatCard
        variant="compact"
        icon={Coins}
        label="Tokens"
        value={hasData ? formatCompact(stats.totalTokens) : "—"}
        {...(hasData && { detail: `in ${formatCompact(stats.totalInput)} · out ${formatCompact(stats.totalOutput)}` })}
      />
    </div>
  );
}

function ChartRpm({ data }: { data: MinuteBucket[] }) {
  if (data.length < 2) return null;
  const total = data.reduce((sum, b) => sum + b.count, 0);
  const peak = Math.max(...data.map((b) => b.count));
  const summary = `Requests per minute chart. ${total} total requests over ${data.length} minutes. Peak: ${peak} requests/min.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Requests / min
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
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
              {...ANIMATION_PROPS}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ChartModels({ data }: { data: ModelCount[] }) {
  if (data.length === 0) return null;
  const total = data.reduce((sum, m) => sum + m.count, 0);
  const topModel = data[0];
  const summary = `Model distribution chart. ${data.length} models, ${total} total requests. Most used: ${topModel?.model ?? "none"} with ${topModel?.count ?? 0} requests.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Models
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
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
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20} {...ANIMATION_PROPS}>
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

function ChartTiming({ data }: { data: TimingPoint[] }) {
  if (data.length < 2) return null;
  const avgLatency = data.reduce((sum, p) => sum + p.latencyMs, 0) / data.length;
  const peak = Math.max(...data.map((p) => p.latencyMs));
  const summary = `Request timing chart showing last ${data.length} requests. Average duration: ${fmtLatency(avgLatency)}. Peak: ${fmtLatency(peak)}.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Timing
        <span className="ml-1 font-normal text-muted-foreground/60">
          (last {data.length})
        </span>
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} strokeOpacity={0.3} />
            <XAxis dataKey="index" {...AXIS_CONFIG} tick={false} />
            <YAxis tickFormatter={(v: number) => fmtLatency(v)} {...AXIS_CONFIG} width={40} />
            <Tooltip content={<TimingTooltip />} />
            <Line
              type="monotone"
              dataKey="latencyMs"
              name="Duration"
              stroke={CHART_COLORS.warning}
              strokeWidth={2}
              dot={{ r: 2, fill: CHART_COLORS.warning }}
              activeDot={{ r: 4 }}
              {...ANIMATION_PROPS}
            />
            <Line
              type="monotone"
              dataKey="ttftMs"
              name="TTFT"
              stroke={getChartColor(1)}
              strokeWidth={1.5}
              dot={{ r: 1.5, fill: getChartColor(1) }}
              activeDot={{ r: 3 }}
              connectNulls
              {...ANIMATION_PROPS}
            />
            <Line
              type="monotone"
              dataKey="processingMs"
              name="Processing"
              stroke={getChartColor(3)}
              strokeWidth={1.5}
              dot={{ r: 1.5, fill: getChartColor(3) }}
              activeDot={{ r: 3 }}
              connectNulls
              strokeDasharray="4 2"
              {...ANIMATION_PROPS}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session UI components
// ---------------------------------------------------------------------------

function ConcurrencyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={TOOLTIP_STYLES.container}>
      <p className={TOOLTIP_STYLES.title}>
        {label ? formatMinute(label) : ""}
      </p>
      <p className={TOOLTIP_STYLES.value}>
        {payload[0]?.value ?? 0} sessions
      </p>
    </div>
  );
}

function ChartConcurrency({ data }: { data: ConcurrencyPoint[] }) {
  if (data.length < 2) return null;
  const peak = Math.max(...data.map((p) => p.sessions));
  const current = data[data.length - 1]?.sessions ?? 0;
  const summary = `Parallel sessions chart over ${data.length} minutes. Current: ${current} sessions. Peak: ${peak} sessions.`;

  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Parallel Sessions
        <span className="ml-1 font-normal text-muted-foreground/60">
          / min
        </span>
      </h4>
      <div style={{ height: CHART_HEIGHTS.compact }} role="img" aria-label={summary}>
        <ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>
          <AreaChart data={data}>
            <defs>
              <linearGradient
                id="concurrencyFill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={getChartColor(2)}
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor={getChartColor(2)}
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
            <YAxis allowDecimals={false} {...AXIS_CONFIG} width={20} />
            <Tooltip content={<ConcurrencyTooltip />} />
            <Area
              type="stepAfter"
              dataKey="sessions"
              stroke={getChartColor(2)}
              fill="url(#concurrencyFill)"
              strokeWidth={2}
              {...ANIMATION_PROPS}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: SessionInfo }) {
  const isActive = session.activeRequests.size > 0;
  const errorRate =
    session.totalRequests > 0
      ? session.errorCount / session.totalRequests
      : 0;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
        isActive
          ? "bg-success/5 border border-success/20"
          : "bg-muted/30",
      )}
    >
      <Circle
        className={cn(
          "size-2 shrink-0 fill-current",
          isActive ? "text-success" : "text-muted-foreground/30",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium truncate">{session.clientName}</span>
          {session.clientVersion && (
            <span className="text-[10px] text-muted-foreground">
              v{session.clientVersion}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
          <span>{session.totalRequests} req</span>
          <span>{formatCompact(session.totalTokens)} tok</span>
          {errorRate > 0 && (
            <span className="text-destructive">
              {formatPercent(errorRate)} err
            </span>
          )}
          {isActive && (
            <span className="text-success font-medium">
              {session.activeRequests.size} active
            </span>
          )}
        </div>
      </div>
      {session.accountName !== "default" &&
        session.accountName !== "dev" && (
          <Badge
            variant="outline"
            className="px-1 py-0 text-[9px] shrink-0"
          >
            {session.accountName}
          </Badge>
        )}
    </div>
  );
}

function SessionList({ sessions }: { sessions: SessionInfo[] }) {
  if (sessions.length === 0) return null;
  return (
    <div className="bg-secondary rounded-lg p-3">
      <h4 className="text-xs font-medium text-muted-foreground mb-2">
        Sessions
        <span className="ml-1 font-normal text-muted-foreground/60">
          ({sessions.length})
        </span>
      </h4>
      <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
        {sessions.map((s) => (
          <SessionRow key={s.sessionId} session={s} />
        ))}
      </div>
    </div>
  );
}

function SessionSection({
  sessionTracker,
  concurrencyData,
}: {
  sessionTracker: ReturnType<typeof useSessionTracker>;
  concurrencyData: ConcurrencyPoint[];
}) {
  return (
    <>
      <StatCard
        variant="compact"
        icon={Users}
        label="Active Sessions"
        value={String(sessionTracker.activeCount)}
        {...(sessionTracker.activeCount > 0 && { detail: `${sessionTracker.totalActiveRequests} in-flight` })}
        accent={
          sessionTracker.activeCount > 3
            ? "warning"
            : sessionTracker.activeCount > 0
              ? "success"
              : "default"
        }
      />
      <ChartConcurrency data={concurrencyData} />
      <SessionList sessions={sessionTracker.sessions} />
    </>
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
  const timingPoints = useTimingPoints(events);
  const sessionTracker = useSessionTracker(events);
  const concurrencyData = useConcurrencyTimeline(events);

  const hasData = stats.total > 0;
  const hasSessionData = sessionTracker.sessions.length > 0;

  return (
    <>
      {/* ── Desktop: fixed-width left sidebar, always visible ── */}
      <div className="hidden lg:flex lg:w-[380px] lg:shrink-0 lg:flex-col lg:gap-6 lg:overflow-y-auto">
        {/* ── Section 1: Requests ── */}
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4" strokeWidth={1.5} />
            Requests
          </h2>
          <div className="space-y-3">
            <RequestCards stats={stats} hasData={hasData} />
            {hasData && (
              <>
                <ChartRpm data={minuteBuckets} />
                <ChartTiming data={timingPoints} />
              </>
            )}
          </div>
        </section>

        {/* ── Section 2: Models ── */}
        {hasData && (
          <section>
            <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Coins className="h-4 w-4" strokeWidth={1.5} />
              Models
            </h2>
            <div className="space-y-3">
              <ModelCards stats={stats} hasData={hasData} />
              <ChartModels data={modelDist} />
            </div>
          </section>
        )}

        {/* ── Section 3: Sessions ── */}
        {hasSessionData && (
          <section>
            <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Users className="h-4 w-4" strokeWidth={1.5} />
              Sessions
            </h2>
            <div className="space-y-3">
              <SessionSection
                sessionTracker={sessionTracker}
                concurrencyData={concurrencyData}
              />
            </div>
          </section>
        )}

        {!hasData && !hasSessionData && (
          <div className="flex items-center justify-center rounded-md border border-dashed py-8 text-xs text-muted-foreground">
            Stats will appear as requests arrive
          </div>
        )}
      </div>

      {/* ── Mobile: collapsible strip above stream ── */}
      <div className="lg:hidden shrink-0 rounded-lg bg-secondary overflow-hidden">
        <button
          type="button"
          onClick={() => setMobileExpanded(!mobileExpanded)}
          className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            Stats
            {(hasData || hasSessionData) && (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {stats.total} req · {hasData ? fmtLatency(stats.avgLatency) : "—"} avg · {formatCompact(stats.totalTokens)} tok
                {hasSessionData && ` · ${sessionTracker.activeCount} sessions`}
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
          <div className="border-t px-3 pb-3 pt-2 space-y-6">
            {/* ── Section 1: Requests ── */}
            <section>
              <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <Activity className="h-4 w-4" strokeWidth={1.5} />
                Requests
              </h2>
              <div className="space-y-3">
                <RequestCards stats={stats} hasData={hasData} />
                {hasData && (
                  <>
                    <ChartRpm data={minuteBuckets} />
                    <ChartTiming data={timingPoints} />
                  </>
                )}
              </div>
            </section>

            {/* ── Section 2: Models ── */}
            {hasData && (
              <section>
                <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                  <Coins className="h-4 w-4" strokeWidth={1.5} />
                  Models
                </h2>
                <div className="space-y-3">
                  <ModelCards stats={stats} hasData={hasData} />
                  <ChartModels data={modelDist} />
                </div>
              </section>
            )}

            {/* ── Section 3: Sessions ── */}
            {hasSessionData && (
              <section>
                <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" strokeWidth={1.5} />
                  Sessions
                </h2>
                <div className="space-y-3">
                  <SessionSection
                    sessionTracker={sessionTracker}
                    concurrencyData={concurrencyData}
                  />
                </div>
              </section>
            )}

            {!hasData && !hasSessionData && (
              <div className="flex items-center justify-center rounded-md border border-dashed py-6 text-xs text-muted-foreground">
                Stats will appear as requests arrive
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
