"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Pause,
  Play,
  Trash2,
  Circle,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ArrowLeft,
  AlertTriangle,
  Monitor,
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

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-yellow-600 dark:text-yellow-400",
  error: "text-red-600 dark:text-red-400",
};

// Map event types to badge variants and labels
type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info"
  | "purple"
  | "teal";

function getEventTypeBadge(event: LogEvent): { variant: BadgeVariant; label: string; icon?: React.ReactNode } {
  const status = event.data?.status as string | undefined;

  switch (event.type) {
    case "request_start":
      return { variant: "info", label: "START", icon: <ArrowRight className="size-3" /> };
    case "request_end":
      return status === "error"
        ? { variant: "destructive", label: "END", icon: <AlertTriangle className="size-3" /> }
        : { variant: "success", label: "END", icon: <ArrowLeft className="size-3" /> };
    case "upstream_error":
      return { variant: "destructive", label: "UPSTREAM ERROR", icon: <AlertTriangle className="size-3" /> };
    case "sse_chunk":
      return { variant: "purple", label: "SSE", icon: undefined };
    case "system":
    default:
      return { variant: "secondary", label: "SYSTEM", icon: <Monitor className="size-3" /> };
  }
}

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

/** Group events by requestId. System events (no requestId) are standalone. */
function groupEvents(events: LogEvent[]) {
  const groups: { key: string; events: LogEvent[] }[] = [];
  const requestMap = new Map<string, number>(); // requestId → index in groups

  for (const event of events) {
    if (!event.requestId) {
      // System events are standalone
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
          connected
            ? "text-green-500"
            : "text-red-500 animate-pulse",
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

/** Single event rendered as a card */
function EventCard({ event, nested = false }: { event: LogEvent; nested?: boolean }) {
  const data = event.data ?? {};
  const model = data.model as string | undefined;
  const resolvedModel = data.resolvedModel as string | undefined;
  const latencyMs = data.latencyMs as number | undefined;
  const inputTokens = data.inputTokens as number | undefined;
  const outputTokens = data.outputTokens as number | undefined;
  const statusCode = data.statusCode as number | undefined;
  const format = data.format as string | undefined;
  const stream = data.stream as boolean | undefined;
  const path = data.path as string | undefined;
  const error = data.error as string | undefined;
  const accountName = data.accountName as string | undefined;
  const messageCount = data.messageCount as number | undefined;
  const toolCount = data.toolCount as number | undefined;

  const badge = getEventTypeBadge(event);
  const hasMetadata = model || latencyMs !== undefined || inputTokens !== undefined || format || path;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card font-mono text-xs",
        nested ? "p-2.5" : "p-3",
        event.level === "error" && "border-red-200 dark:border-red-900/50",
        event.level === "warn" && "border-yellow-200 dark:border-yellow-900/50",
      )}
    >
      {/* Row 1: type badge + time + status tags */}
      <div className="flex items-center gap-2">
        <Badge variant={badge.variant} className="gap-1 px-1.5 py-0 text-[10px] font-semibold">
          {badge.icon}
          {badge.label}
        </Badge>
        <span className="text-muted-foreground tabular-nums" title={new Date(event.ts).toISOString()}>
          {formatTime(event.ts)}
        </span>
        {/* Level badge for warn/error */}
        {(event.level === "warn" || event.level === "error") && (
          <Badge
            variant={event.level === "error" ? "destructive" : "warning"}
            className="px-1.5 py-0 text-[10px]"
          >
            {event.level}
          </Badge>
        )}
        {/* Status code tag */}
        {statusCode !== undefined && (
          <Badge
            variant={statusCode >= 400 ? "destructive" : "success"}
            className="px-1.5 py-0 text-[10px] font-mono"
          >
            {statusCode}
          </Badge>
        )}
        {/* Streaming indicator */}
        {stream !== undefined && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {stream ? "stream" : "sync"}
          </Badge>
        )}
      </div>

      {/* Row 2: message */}
      <p className={cn("mt-1.5 leading-relaxed break-all", LEVEL_COLORS[event.level])}>
        {event.msg}
      </p>

      {/* Row 3: error detail */}
      {error && event.type !== "request_start" && (
        <p className="mt-1 text-red-600 dark:text-red-400 leading-relaxed break-all">
          {error}
        </p>
      )}

      {/* Row 4: metadata tags */}
      {hasMetadata && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {path && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono">
              {path}
            </Badge>
          )}
          {model && (
            <Badge variant="purple" className="px-1.5 py-0 text-[10px]">
              {model}
            </Badge>
          )}
          {resolvedModel && resolvedModel !== model && (
            <Badge variant="teal" className="px-1.5 py-0 text-[10px]">
              resolved: {resolvedModel}
            </Badge>
          )}
          {format && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {format}
            </Badge>
          )}
          {accountName && accountName !== "default" && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {accountName}
            </Badge>
          )}
          {latencyMs !== undefined && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] tabular-nums font-mono">
              {latencyMs}ms
            </Badge>
          )}
          {inputTokens !== undefined && outputTokens !== undefined && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] tabular-nums font-mono">
              in:{inputTokens} out:{outputTokens}
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
      )}
    </div>
  );
}

/** A group of events sharing the same requestId, rendered as an expandable card */
function RequestGroup({
  events,
  defaultExpanded = false,
}: {
  events: LogEvent[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Single event (system or solo) — render as standalone card
  if (events.length === 1 && !events[0]!.requestId) {
    return <EventCard event={events[0]!} />;
  }

  // Multi-event request group
  const startEvent = events.find((e) => e.type === "request_start");
  const endEvent = events.find((e) => e.type === "request_end");
  const hasError = events.some((e) => e.level === "error");
  const summaryEvent = startEvent ?? events[0]!;

  const data = endEvent?.data ?? startEvent?.data ?? {};
  const model = data.model as string | undefined;
  const latencyMs = data.latencyMs as number | undefined;
  const inputTokens = data.inputTokens as number | undefined;
  const outputTokens = data.outputTokens as number | undefined;
  const status = data.status as string | undefined;
  const format = data.format as string | undefined;
  const stream = data.stream as boolean | undefined;
  const statusCode = data.statusCode as number | undefined;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card overflow-hidden",
        hasError
          ? "border-red-200 dark:border-red-900/50"
          : "border-border",
      )}
    >
      {/* Summary header — clickable */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex w-full items-start gap-2.5 p-3 text-left font-mono text-xs transition-colors hover:bg-muted/50",
        )}
      >
        <div className="mt-0.5 shrink-0">
          {expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* Row 1: badges + time */}
          <div className="flex flex-wrap items-center gap-1.5">
            {status === "error" ? (
              <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px] font-semibold">
                <AlertTriangle className="size-3" />
                ERROR
              </Badge>
            ) : endEvent ? (
              <Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px] font-semibold">
                OK
              </Badge>
            ) : (
              <Badge variant="info" className="gap-1 px-1.5 py-0 text-[10px] font-semibold">
                <ArrowRight className="size-3" />
                IN PROGRESS
              </Badge>
            )}
            {statusCode !== undefined && (
              <Badge
                variant={statusCode >= 400 ? "destructive" : "success"}
                className="px-1.5 py-0 text-[10px] font-mono"
              >
                {statusCode}
              </Badge>
            )}
            <span className="text-muted-foreground tabular-nums">
              {formatTime(summaryEvent.ts)}
            </span>
          </div>

          {/* Row 2: message */}
          <p className="mt-1 leading-relaxed">
            {summaryEvent.msg}
          </p>

          {/* Row 3: metadata tags */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {model && (
              <Badge variant="purple" className="px-1.5 py-0 text-[10px]">
                {model}
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
            {latencyMs !== undefined && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] tabular-nums font-mono">
                {latencyMs}ms
              </Badge>
            )}
            {inputTokens !== undefined && outputTokens !== undefined && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] tabular-nums font-mono">
                in:{inputTokens} out:{outputTokens}
              </Badge>
            )}
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {events.length} events
            </Badge>
          </div>
        </div>
      </button>

      {/* Expanded: individual event cards */}
      {expanded && (
        <div className="space-y-1.5 border-t border-border bg-muted/30 p-2.5">
          {events.map((event, i) => (
            <EventCard key={`${event.ts}-${i}`} event={event} nested />
          ))}
        </div>
      )}
    </div>
  );
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

  // Handle level change — update both local state and stream
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
              <RequestGroup
                key={group.key}
                events={group.events}
                defaultExpanded={group.events.length <= 2}
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
