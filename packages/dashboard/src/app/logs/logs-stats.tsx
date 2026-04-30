"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Activity,
  AlertTriangle,
  Timer,
  Coins,
  Users,
  Zap,
} from "lucide-react";
import {
  formatCompact,
  formatLatency as fmtLatency,
} from "@/lib/chart-config";
import { StatCard } from "@/components/stats/stat-card";
import { RpmChart } from "@/components/analytics/panels/rpm-chart";
import { ModelDistribution } from "@/components/analytics/panels/model-distribution";
import { TimingChart } from "@/components/analytics/panels/timing-chart";
import { ConcurrencyChart } from "@/components/analytics/panels/concurrency-chart";
import { SessionList } from "@/components/analytics/panels/session-list";
import type {
  MinuteBucket,
  ModelCount,
  TimingPoint,
  ConcurrencyBucket,
  SessionInfo,
} from "@/components/analytics/panels/types";
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
// Session tracking — uses SessionInfo and ConcurrencyBucket from panels/types
// ---------------------------------------------------------------------------

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

export function computeConcurrencyTimeline(events: LogEvent[]): ConcurrencyBucket[] {
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

export function useConcurrencyTimeline(events: LogEvent[]): ConcurrencyBucket[] {
  const minuteTick = useMinuteTick();
  // minuteTick forces re-computation every minute so in-progress requests
  // extend their timeline to the current minute even without new events.
  return useMemo(() => computeConcurrencyTimeline(events), [events, minuteTick]);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Chart sections (use extracted panel components)
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

function SessionSection({
  sessionTracker,
  concurrencyData,
}: {
  sessionTracker: ReturnType<typeof useSessionTracker>;
  concurrencyData: ConcurrencyBucket[];
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
      <ConcurrencyChart data={concurrencyData} gradientId="logConcurrencyFill" />
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
                <RpmChart data={minuteBuckets} gradientId="logRpmFill" />
                <TimingChart data={timingPoints} />
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
              <ModelDistribution data={modelDist} />
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
                    <RpmChart data={minuteBuckets} gradientId="logRpmFillMobile" />
                    <TimingChart data={timingPoints} />
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
                  <ModelDistribution data={modelDist} />
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
