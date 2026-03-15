"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Pause,
  Play,
  Trash2,
  Circle,
  ChevronDown,
  ChevronRight,
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

const LEVEL_BORDER: Record<LogLevel, string> = {
  debug: "",
  info: "",
  warn: "border-l-2 border-l-yellow-500",
  error: "border-l-2 border-l-red-500",
};

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

function EventLine({ event }: { event: LogEvent }) {
  const data = event.data ?? {};
  const model = data.model as string | undefined;
  const latencyMs = data.latencyMs as number | undefined;
  const inputTokens = data.inputTokens as number | undefined;
  const outputTokens = data.outputTokens as number | undefined;
  const status = data.status as string | undefined;

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-3 py-1 font-mono text-xs leading-5",
        LEVEL_BORDER[event.level],
      )}
    >
      <span className="shrink-0 text-muted-foreground tabular-nums" title={new Date(event.ts).toISOString()}>
        {formatTime(event.ts)}
      </span>
      <Badge
        variant="outline"
        className={cn("shrink-0 px-1 py-0 text-[10px] font-normal", LEVEL_COLORS[event.level])}
      >
        {event.level}
      </Badge>
      <span className={cn("shrink-0 text-muted-foreground", LEVEL_COLORS[event.level])}>
        {event.type}
      </span>
      <span className={cn("flex-1 truncate", LEVEL_COLORS[event.level])}>
        {event.msg}
      </span>
      {/* Metadata chips */}
      {model && (
        <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px] font-normal">
          {model}
        </Badge>
      )}
      {latencyMs !== undefined && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {latencyMs}ms
        </span>
      )}
      {inputTokens !== undefined && outputTokens !== undefined && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {inputTokens}/{outputTokens}
        </span>
      )}
      {status === "error" && (
        <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[10px]">
          error
        </Badge>
      )}
    </div>
  );
}

function RequestGroup({
  events,
  defaultExpanded = false,
}: {
  events: LogEvent[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Single event (system) — no grouping
  if (events.length === 1 && !events[0]!.requestId) {
    return <EventLine event={events[0]!} />;
  }

  // Find the summary events
  const startEvent = events.find((e) => e.type === "request_start");
  const endEvent = events.find((e) => e.type === "request_end");
  const summaryEvent = startEvent ?? events[0]!;
  const hasError = events.some((e) => e.level === "error");

  return (
    <div>
      {/* Group header — clickable */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1 font-mono text-xs leading-5 hover:bg-muted/50 transition-colors",
          hasError ? "border-l-2 border-l-red-500" : "",
        )}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-muted-foreground tabular-nums" title={new Date(summaryEvent.ts).toISOString()}>
          {formatTime(summaryEvent.ts)}
        </span>
        <span className="flex-1 truncate text-left">
          {summaryEvent.msg}
        </span>
        {endEvent && (
          <>
            {endEvent.data?.status === "error" ? (
              <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[10px]">
                error
              </Badge>
            ) : (
              <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] text-green-600 dark:text-green-400">
                ok
              </Badge>
            )}
            {endEvent.data?.latencyMs !== undefined && (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {endEvent.data.latencyMs as number}ms
              </span>
            )}
            {endEvent.data?.inputTokens !== undefined && (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                in:{endEvent.data.inputTokens as number} out:{endEvent.data.outputTokens as number}
              </span>
            )}
          </>
        )}
        <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px] font-normal">
          {events.length}
        </Badge>
      </button>
      {/* Expanded detail */}
      {expanded && (
        <div className="ml-5 border-l border-border">
          {events.map((event, i) => (
            <EventLine key={`${event.ts}-${i}`} event={event} />
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
      <div className="flex items-center justify-between gap-3">
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
        <div className="flex items-center gap-2 rounded-md bg-yellow-50 px-3 py-1.5 text-xs text-yellow-800 dark:bg-yellow-950/30 dark:text-yellow-200">
          <Pause className="size-3" />
          Paused — new events are being buffered
        </div>
      )}

      {/* Log stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto rounded-md border bg-card"
      >
        {groups.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {connected
              ? "Waiting for log events..."
              : "Connecting to log stream..."}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {groups.map((group) => (
              <RequestGroup
                key={group.key}
                events={group.events}
                defaultExpanded={group.events.length <= 3}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer status */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {filteredEvents.length} events
          {search && ` (filtered from ${events.length})`}
        </span>
        <span>{relativeTime(events[events.length - 1]?.ts ?? Date.now())}</span>
      </div>
    </div>
  );
}
