"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Pause,
  Play,
  Trash2,
  Circle,
  ChevronDown,
  ChevronRight,
  Monitor,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useLogStream,
  type LogEvent,
  type LogLevel,
} from "@/hooks/use-log-stream";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Group events by requestId. System events (no requestId) are standalone. */
function groupEvents(events: LogEvent[]) {
  const groups: { key: string; events: LogEvent[] }[] = [];
  const requestMap = new Map<string, number>();

  for (const event of events) {
    if (!event.requestId) {
      groups.push({ key: `sys-${event.ts}-${Math.random()}`, events: [event] });
    } else {
      const existing = requestMap.get(event.requestId);
      if (existing !== undefined) {
        groups[existing]!.events.push(event);
      } else {
        requestMap.set(event.requestId, groups.length);
        groups.push({ key: event.requestId, events: [event] });
      }
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectionIndicator({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Circle
        className={cn(
          "size-2 fill-current",
          connected ? "text-green-500" : "text-red-500 animate-pulse",
        )}
      />
      <span className="text-muted-foreground">
        {connected ? "Connected" : "Reconnecting..."}
      </span>
    </div>
  );
}

function LevelSelect({
  value,
  onChange,
}: {
  value: LogLevel;
  onChange: (level: LogLevel) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as LogLevel)}
      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
    >
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {l.charAt(0).toUpperCase() + l.slice(1)}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// System event — simple card
// ---------------------------------------------------------------------------

function SystemEventCard({ event }: { event: LogEvent }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 font-mono text-xs",
        event.level === "error" && "border-red-200 dark:border-red-900/50",
        event.level === "warn" && "border-yellow-200 dark:border-yellow-900/50",
      )}
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
          <Monitor className="size-3" />
          SYSTEM
        </Badge>
        {(event.level === "warn" || event.level === "error") && (
          <Badge
            variant={event.level === "error" ? "destructive" : "warning"}
            className="px-1.5 py-0 text-[10px]"
          >
            {event.level}
          </Badge>
        )}
        <span className="text-muted-foreground tabular-nums">
          {formatTime(event.ts)}
        </span>
      </div>
      <p className={cn(
        "mt-1.5 leading-relaxed",
        event.level === "error" ? "text-red-600 dark:text-red-400" :
        event.level === "warn" ? "text-yellow-600 dark:text-yellow-400" :
        "text-foreground",
      )}>
        {event.msg}
      </p>
      {typeof event.data?.error === "string" && (
        <p className="mt-1 text-red-600 dark:text-red-400 break-all leading-relaxed">
          {event.data.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request card — header + timeline
// ---------------------------------------------------------------------------

function RequestCard({
  events,
  defaultExpanded = false,
}: {
  events: LogEvent[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const startEvent = events.find((e) => e.type === "request_start");
  const endEvent = events.find((e) => e.type === "request_end");
  const errorEvents = events.filter((e) => e.type === "upstream_error");

  // Merge data from start + end, prefer end for result fields
  const startData = startEvent?.data ?? {};
  const endData = endEvent?.data ?? {};

  const method = (startData.path as string)?.startsWith("/") ? "POST" : "GET";
  const path = (startData.path ?? endData.path) as string | undefined;
  const model = (startData.model ?? endData.model) as string | undefined;
  const resolvedModel = endData.resolvedModel as string | undefined;
  const format = (startData.format ?? endData.format) as string | undefined;
  const stream = (startData.stream ?? endData.stream) as boolean | undefined;
  const accountName = (startData.accountName ?? endData.accountName) as string | undefined;
  const messageCount = startData.messageCount as number | undefined;
  const toolCount = startData.toolCount as number | undefined;

  // End-only fields
  const latencyMs = endData.latencyMs as number | undefined;
  const statusCode = endData.statusCode as number | undefined;
  const status = endData.status as string | undefined;
  const inputTokens = endData.inputTokens as number | undefined;
  const outputTokens = endData.outputTokens as number | undefined;
  const error = endData.error as string | undefined;

  // Determine method from path
  const httpMethod = path === "/v1/models" ? "GET" : method;

  // State
  const isComplete = !!endEvent;
  const isError = status === "error";
  const isInProgress = !isComplete;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card overflow-hidden",
        isError ? "border-red-200 dark:border-red-900/50" : "border-border",
      )}
    >
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 p-3 pb-0">
        <div className="min-w-0 flex-1">
          {/* Method + Path */}
          <div className="flex items-center gap-2 font-mono text-sm">
            <Badge variant={httpMethod === "GET" ? "teal" : "info"} className="px-1.5 py-0 text-[10px] font-bold">
              {httpMethod}
            </Badge>
            <span className="font-semibold truncate">{path ?? "unknown"}</span>
          </div>
          {/* Tags row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {model && (
              <Badge variant="purple" className="px-1.5 py-0 text-[10px]">
                {model}
              </Badge>
            )}
            {resolvedModel && resolvedModel !== model && (
              <Badge variant="teal" className="px-1.5 py-0 text-[10px]">
                &rarr; {resolvedModel}
              </Badge>
            )}
            {format && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {format}
              </Badge>
            )}
            {stream !== undefined && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {stream ? "stream" : "sync"}
              </Badge>
            )}
            {accountName && accountName !== "default" && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {accountName}
              </Badge>
            )}
            {messageCount !== undefined && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] tabular-nums">
                {messageCount} msgs
              </Badge>
            )}
            {toolCount !== undefined && toolCount > 0 && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] tabular-nums">
                {toolCount} tools
              </Badge>
            )}
          </div>
        </div>
        {/* Overall status badge — top right */}
        <div className="shrink-0">
          {isError ? (
            <Badge variant="destructive" className="px-2 py-0.5 text-[11px] font-semibold">
              ERROR
            </Badge>
          ) : isComplete ? (
            <Badge variant="success" className="px-2 py-0.5 text-[11px] font-semibold">
              {statusCode ?? 200}
            </Badge>
          ) : (
            <Badge variant="info" className="gap-1 px-2 py-0.5 text-[11px] font-semibold">
              <Loader2 className="size-3 animate-spin" />
              IN PROGRESS
            </Badge>
          )}
        </div>
      </div>

      {/* ── Timeline ── */}
      <div className="px-3 py-3">
        <div className="flex items-center gap-0 font-mono text-[11px]">
          {/* Start node */}
          <div className="flex shrink-0 flex-col items-center">
            <div className={cn(
              "flex items-center justify-center rounded-full size-7 border-2",
              isError
                ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/50"
                : "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/50",
            )}>
              <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400">S</span>
            </div>
            <span className="mt-1 text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
              {startEvent ? formatTime(startEvent.ts) : "—"}
            </span>
          </div>

          {/* Connector line + metrics */}
          <div className="relative mx-1 flex flex-1 items-center">
            {/* The line */}
            <div className={cn(
              "h-0.5 w-full rounded-full",
              isError
                ? "bg-red-300 dark:bg-red-800"
                : isInProgress
                  ? "bg-blue-200 dark:bg-blue-900 animate-pulse"
                  : "bg-green-300 dark:bg-green-800",
            )} />
            {/* Arrow head */}
            <div className={cn(
              "absolute right-0 size-0 border-y-[4px] border-y-transparent border-l-[6px]",
              isError
                ? "border-l-red-400 dark:border-l-red-700"
                : isInProgress
                  ? "border-l-blue-300 dark:border-l-blue-800"
                  : "border-l-green-400 dark:border-l-green-700",
            )} />
            {/* Metrics label on the line */}
            <div className="absolute inset-x-0 -top-4 flex items-center justify-center gap-3">
              {latencyMs !== undefined && (
                <span className="rounded bg-background px-1 text-[10px] font-medium tabular-nums text-foreground">
                  {formatLatency(latencyMs)}
                </span>
              )}
              {isInProgress && (
                <span className="rounded bg-background px-1 text-[10px] text-muted-foreground">
                  waiting...
                </span>
              )}
            </div>
            {/* Metrics below the line */}
            {(inputTokens !== undefined || error) && (
              <div className="absolute inset-x-0 top-3 flex items-center justify-center gap-3">
                {inputTokens !== undefined && outputTokens !== undefined && (
                  <span className="rounded bg-background px-1 text-[10px] tabular-nums text-muted-foreground">
                    input {formatTokens(inputTokens)} &middot; output {formatTokens(outputTokens)} &middot; total {formatTokens(inputTokens + outputTokens)}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Error node (if upstream_error occurred) */}
          {errorEvents.length > 0 && (
            <>
              <div className="flex shrink-0 flex-col items-center mx-1">
                <div className="flex items-center justify-center rounded-full size-7 border-2 border-red-400 bg-red-100 dark:border-red-700 dark:bg-red-950/50">
                  <span className="text-[9px] font-bold text-red-600 dark:text-red-400">!</span>
                </div>
                <span className="mt-1 text-[10px] text-red-500 whitespace-nowrap">
                  upstream
                </span>
              </div>
              {/* Second connector to end */}
              <div className="relative mx-1 flex flex-1 max-w-16 items-center">
                <div className="h-0.5 w-full rounded-full bg-red-300 dark:bg-red-800" />
                <div className="absolute right-0 size-0 border-y-[4px] border-y-transparent border-l-[6px] border-l-red-400 dark:border-l-red-700" />
              </div>
            </>
          )}

          {/* End node */}
          <div className="flex shrink-0 flex-col items-center">
            {isComplete ? (
              <div className={cn(
                "flex items-center justify-center rounded-full size-7 border-2",
                isError
                  ? "border-red-400 bg-red-100 dark:border-red-700 dark:bg-red-950/50"
                  : "border-green-400 bg-green-100 dark:border-green-700 dark:bg-green-950/50",
              )}>
                <span className={cn(
                  "text-[9px] font-bold",
                  isError ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400",
                )}>
                  {isError ? "E" : "OK"}
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-full size-7 border-2 border-dashed border-muted-foreground/40">
                <Loader2 className="size-3 text-muted-foreground animate-spin" />
              </div>
            )}
            <span className={cn(
              "mt-1 text-[10px] tabular-nums whitespace-nowrap",
              isError ? "text-red-500" : isComplete ? "text-muted-foreground" : "text-muted-foreground/50",
            )}>
              {endEvent ? formatTime(endEvent.ts) : "pending"}
            </span>
          </div>
        </div>

        {/* Error message below timeline */}
        {error && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}
        {errorEvents.map((ev, i) => (
          <div key={i} className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {ev.data?.error as string ?? ev.msg}
          </div>
        ))}
      </div>

      {/* ── Expandable raw events ── */}
      {events.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {events.length} raw events
            {startEvent?.requestId && (
              <span className="ml-auto font-mono text-[10px] opacity-50">
                {startEvent.requestId.slice(0, 8)}
              </span>
            )}
          </button>
          {expanded && (
            <div className="border-t border-border bg-muted/20 px-3 py-2 space-y-1">
              {events.map((event, i) => (
                <RawEventLine key={`${event.ts}-${i}`} event={event} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact single-line raw event for expanded detail view */
function RawEventLine({ event }: { event: LogEvent }) {
  const badge = getRawBadge(event);
  return (
    <div className="flex items-start gap-2 font-mono text-[11px] leading-5">
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatTime(event.ts)}
      </span>
      <Badge variant={badge.variant} className="shrink-0 px-1 py-0 text-[9px]">
        {badge.label}
      </Badge>
      <span className={cn(
        "flex-1 break-all",
        event.level === "error" ? "text-red-600 dark:text-red-400" :
        event.level === "warn" ? "text-yellow-600 dark:text-yellow-400" :
        "text-muted-foreground",
      )}>
        {event.msg}
      </span>
    </div>
  );
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "purple" | "teal";

function getRawBadge(event: LogEvent): { variant: BadgeVariant; label: string } {
  switch (event.type) {
    case "request_start": return { variant: "info", label: "START" };
    case "request_end": {
      const s = event.data?.status as string | undefined;
      return s === "error"
        ? { variant: "destructive", label: "END" }
        : { variant: "success", label: "END" };
    }
    case "upstream_error": return { variant: "destructive", label: "ERR" };
    case "sse_chunk": return { variant: "purple", label: "SSE" };
    case "system":
    default: return { variant: "secondary", label: "SYS" };
  }
}

// ---------------------------------------------------------------------------
// Group renderer — dispatches to SystemEventCard or RequestCard
// ---------------------------------------------------------------------------

function EventGroup({
  events,
  defaultExpanded,
}: {
  events: LogEvent[];
  defaultExpanded: boolean;
}) {
  // Standalone system event
  if (events.length === 1 && !events[0]!.requestId) {
    return <SystemEventCard event={events[0]!} />;
  }

  return <RequestCard events={events} defaultExpanded={defaultExpanded} />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LogsContent() {
  const [level, setLevel] = useState<LogLevel>("info");
  const [search, setSearch] = useState("");
  const { events, connected, paused, setPaused, clear, setLevel: setStreamLevel } = useLogStream({
    level,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevEventsLenRef = useRef(0);

  const handleLevelChange = useCallback(
    (newLevel: LogLevel) => {
      setLevel(newLevel);
      setStreamLevel(newLevel);
    },
    [setStreamLevel],
  );

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (
      autoScrollRef.current &&
      scrollRef.current &&
      events.length > prevEventsLenRef.current
    ) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevEventsLenRef.current = events.length;
  }, [events.length]);

  // Detect manual scroll — pause auto-scroll when user scrolls up
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  // Filter events by search
  const filteredEvents = search
    ? events.filter(
        (e) =>
          e.msg.toLowerCase().includes(search.toLowerCase()) ||
          e.requestId?.toLowerCase().includes(search.toLowerCase()) ||
          (e.data?.model as string)?.toLowerCase().includes(search.toLowerCase()),
      )
    : events;

  const groups = groupEvents(filteredEvents);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Logs</h1>
          <ConnectionIndicator connected={connected} />
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-48 text-xs"
          />
          <LevelSelect value={level} onChange={handleLevelChange} />
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={() => setPaused(!paused)}
          >
            {paused ? (
              <>
                <Play className="size-3" />
                Resume
              </>
            ) : (
              <>
                <Pause className="size-3" />
                Pause
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={clear}
          >
            <Trash2 className="size-3" />
            Clear
          </Button>
        </div>
      </div>

      {/* Pause banner */}
      {paused && (
        <div className="flex shrink-0 items-center gap-2 rounded-md bg-yellow-50 px-3 py-1.5 text-xs text-yellow-800 dark:bg-yellow-950/30 dark:text-yellow-200">
          <Pause className="size-3" />
          Paused — new events are being buffered
        </div>
      )}

      {/* Log stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {groups.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-md border bg-card text-sm text-muted-foreground">
            {connected
              ? "Waiting for log events..."
              : "Connecting to log stream..."}
          </div>
        ) : (
          <div className="max-w-3xl space-y-2">
            {groups.map((group) => (
              <EventGroup
                key={group.key}
                events={group.events}
                defaultExpanded={false}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer status */}
      <div className="flex shrink-0 items-center justify-between text-xs text-muted-foreground">
        <span>
          {filteredEvents.length} events
          {search && ` (filtered from ${events.length})`}
        </span>
        <span>{relativeTime(events[events.length - 1]?.ts ?? Date.now())}</span>
      </div>
    </div>
  );
}
