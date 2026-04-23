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
  Rocket,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  useLogStream,
  type LogEvent,
  type LogLevel,
} from "@/hooks/use-log-stream";
import { LogsStats } from "./logs-stats";

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

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "purple" | "teal";

const STRATEGY_PILL: Record<
  string,
  { variant: BadgeVariant; label: string; title: string }
> = {
  "copilot-native": {
    variant: "success",
    label: "native",
    title: "Copilot native Anthropic (/v1/messages → Copilot /v1/messages, no translation)",
  },
  "copilot-translated": {
    variant: "destructive",
    label: "translated",
    title: "Anthropic client → Copilot /chat/completions (A↔O translation)",
  },
  "copilot-openai-direct": {
    variant: "info",
    label: "openai-direct",
    title: "OpenAI client → Copilot /chat/completions (passthrough)",
  },
  "copilot-responses": {
    variant: "teal",
    label: "responses",
    title: "Responses client → Copilot /responses (passthrough)",
  },
  "custom-openai": {
    variant: "purple",
    label: "custom-openai",
    title: "Custom OpenAI-compatible upstream",
  },
  "custom-anthropic": {
    variant: "warning",
    label: "custom-anthropic",
    title: "Custom Anthropic-compatible upstream",
  },
};

/** Serialize events to a readable text for clipboard */
function serializeEvents(events: LogEvent[]): string {
  return events
    .map((e) => {
      const ts = new Date(e.ts).toISOString();
      const data = e.data ? ` ${JSON.stringify(e.data)}` : "";
      return `[${ts}] ${e.level.toUpperCase()} ${e.type}${e.requestId ? ` (${e.requestId})` : ""}: ${e.msg}${data}`;
    })
    .join("\n");
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

  // Newest first — reverse so latest groups appear at the top
  return groups.reverse();
}

// ---------------------------------------------------------------------------
// Copy button hook
// ---------------------------------------------------------------------------

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 800);
    });
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { copied, copy };
}

function CopyButton({ events }: { events: LogEvent[] }) {
  const { copied, copy } = useCopyFeedback();

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copy(serializeEvents(events));
      }}
      className={cn(
        "flex shrink-0 items-center justify-center min-h-11 min-w-11 transition-colors",
        copied
          ? "text-success"
          : "text-muted-foreground/40 hover:text-muted-foreground",
      )}
      title="Copy raw events"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </button>
  );
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
          connected ? "text-success" : "text-destructive animate-pulse",
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
    <Select value={value} onValueChange={(v) => onChange(v as LogLevel)}>
      <SelectTrigger size="sm" className="text-xs min-w-[90px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEVELS.map((l) => (
          <SelectItem key={l} value={l}>
            {l.charAt(0).toUpperCase() + l.slice(1)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// System event — simple card
// ---------------------------------------------------------------------------

function SystemEventCard({ event }: { event: LogEvent }) {
  return (
    <div className="flex items-start gap-2">
      <div className="shrink-0 pt-3">
        <CopyButton events={[event]} />
      </div>
      <div
        className={cn(
          "flex-1 rounded-lg border bg-secondary p-3 font-mono text-xs",
          event.level === "error" && "border-destructive/30",
          event.level === "warn" && "border-warning/30",
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
          event.level === "error" ? "text-destructive" :
          event.level === "warn" ? "text-warning" :
          "text-foreground",
        )}>
          {event.msg}
        </p>
        {typeof event.data?.error === "string" && (
          <p className="mt-1 text-destructive break-all leading-relaxed">
            {event.data.error}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase detail — shows events relevant to a clicked timeline node
// ---------------------------------------------------------------------------

function PhaseDetail({
  phase,
  events,
  onClose,
}: {
  phase: "start" | "error" | "end";
  events: LogEvent[];
  onClose: () => void;
}) {
  const phaseEvents = events.filter((e) => {
    if (phase === "start") return e.type === "request_start";
    if (phase === "error") return e.type === "upstream_error";
    if (phase === "end") return e.type === "request_end";
    return false;
  });

  if (phaseEvents.length === 0) return null;

  const phaseLabel = phase === "start" ? "Request Start" : phase === "error" ? "Upstream Error" : "Request End";

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-2.5 font-mono text-[11px]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{phaseLabel}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close phase details"
          className="flex items-center justify-center min-h-11 min-w-11 -mr-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="text-sm">✕</span>
        </button>
      </div>
      {phaseEvents.map((ev, i) => {
        const data = ev.data ? { ...ev.data } : null;
        return (
          <div key={i} className="space-y-1">
            <p className="text-muted-foreground">{ev.msg}</p>
            {data && Object.keys(data).length > 0 && (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
                {Object.entries(data).map(([key, val]) => (
                  <div key={key} className="contents">
                    <span className="text-muted-foreground/70">{key}</span>
                    <span className="text-foreground truncate">
                      {typeof val === "object" ? JSON.stringify(val) : String(val)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
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
  const [focusedPhase, setFocusedPhase] = useState<"start" | "error" | "end" | null>(null);

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
  const strategy = endData.strategy as string | undefined;

  // End-only fields
  const latencyMs = endData.latencyMs as number | undefined;
  const statusCode = endData.statusCode as number | undefined;
  const status = endData.status as string | undefined;
  const inputTokens = endData.inputTokens as number | undefined;
  const outputTokens = endData.outputTokens as number | undefined;
  const error = endData.error as string | undefined;

  const httpMethod = path === "/v1/models" ? "GET" : method;

  const isComplete = !!endEvent;
  const isError = status === "error";
  const isInProgress = !isComplete;

  return (
    <div className="flex items-start gap-2">
      <div className="shrink-0 pt-3">
        <CopyButton events={events} />
      </div>
      <div
        className={cn(
          "flex-1 rounded-lg border bg-secondary overflow-hidden",
          isError ? "border-destructive/30" : "border-border",
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
              {strategy && STRATEGY_PILL[strategy] && (
                <Badge
                  variant={STRATEGY_PILL[strategy]!.variant}
                  className="px-1.5 py-0 text-[10px] font-semibold"
                  title={STRATEGY_PILL[strategy]!.title}
                >
                  {STRATEGY_PILL[strategy]!.label}
                </Badge>
              )}
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
              <button
                type="button"
                onClick={() => setFocusedPhase(focusedPhase === "start" ? null : "start")}
                aria-label="View request start details"
                aria-expanded={focusedPhase === "start"}
                className={cn(
                  "flex items-center justify-center min-h-11 min-w-11 cursor-pointer transition-shadow",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-full",
                )}>
                <span className={cn(
                  "flex items-center justify-center rounded-full size-7 border-2 transition-shadow",
                  isError
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-info/40 bg-info/10",
                  focusedPhase === "start" && "ring-2 ring-info/50",
                  "group-hover:ring-2 group-hover:ring-info/30",
                )}>
                  <span className="text-[9px] font-bold text-info" aria-hidden="true">S</span>
                </span>
              </button>
              <span className="mt-1 text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                {startEvent ? formatTime(startEvent.ts) : "—"}
              </span>
            </div>

            {/* Connector line + metrics */}
            <div className="relative mx-1 flex flex-1 items-center">
              <div className={cn(
                "h-0.5 w-full rounded-full",
                isError
                  ? "bg-destructive/40"
                  : isInProgress
                    ? "bg-info/30 animate-pulse"
                    : "bg-success/40",
              )} />
              <div className={cn(
                "absolute right-0 size-0 border-y-[4px] border-y-transparent border-l-[6px]",
                isError
                  ? "border-l-destructive/50"
                  : isInProgress
                    ? "border-l-info/40"
                    : "border-l-success/50",
              )} />
              {/* Metrics above line */}
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
              {/* Metrics below line */}
              {inputTokens !== undefined && outputTokens !== undefined && (
                <div className="absolute inset-x-0 top-3 flex items-center justify-center">
                  <span className="rounded bg-background px-1 text-[10px] tabular-nums text-muted-foreground">
                    input {formatTokens(inputTokens)} &middot; output {formatTokens(outputTokens)} &middot; total {formatTokens(inputTokens + outputTokens)}
                  </span>
                </div>
              )}
            </div>

            {/* Error node (if upstream_error occurred) */}
            {errorEvents.length > 0 && (
              <>
                <div className="flex shrink-0 flex-col items-center mx-1">
                  <button
                    type="button"
                    onClick={() => setFocusedPhase(focusedPhase === "error" ? null : "error")}
                    aria-label="View upstream error details"
                    aria-expanded={focusedPhase === "error"}
                    className={cn(
                      "flex items-center justify-center min-h-11 min-w-11 cursor-pointer transition-shadow",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-full",
                    )}>
                    <span className={cn(
                      "flex items-center justify-center rounded-full size-7 border-2 border-destructive/50 bg-destructive/10 transition-shadow",
                      focusedPhase === "error" && "ring-2 ring-destructive/50",
                    )}>
                      <span className="text-[9px] font-bold text-destructive" aria-hidden="true">!</span>
                    </span>
                  </button>
                  <span className="mt-1 text-[10px] text-destructive whitespace-nowrap">
                    upstream
                  </span>
                </div>
                <div className="relative mx-1 flex flex-1 max-w-16 items-center">
                  <div className="h-0.5 w-full rounded-full bg-destructive/40" />
                  <div className="absolute right-0 size-0 border-y-[4px] border-y-transparent border-l-[6px] border-l-destructive/50" />
                </div>
              </>
            )}

            {/* End node */}
            <div className="flex shrink-0 flex-col items-center">
              {isComplete ? (
                <button
                  type="button"
                  onClick={() => setFocusedPhase(focusedPhase === "end" ? null : "end")}
                  aria-label={isError ? "View request error details" : "View request completion details"}
                  aria-expanded={focusedPhase === "end"}
                  className={cn(
                    "flex items-center justify-center min-h-11 min-w-11 cursor-pointer transition-shadow",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-full",
                  )}>
                  <span className={cn(
                    "flex items-center justify-center rounded-full size-7 border-2 transition-shadow",
                    isError
                      ? "border-destructive/50 bg-destructive/10"
                      : "border-success/50 bg-success/10",
                    focusedPhase === "end" && (isError ? "ring-2 ring-destructive/50" : "ring-2 ring-success/50"),
                  )}>
                    <span className={cn(
                      "text-[9px] font-bold",
                      isError ? "text-destructive" : "text-success",
                    )} aria-hidden="true">
                      {isError ? "E" : "OK"}
                    </span>
                  </span>
                </button>
              ) : (
                <div className="flex items-center justify-center rounded-full size-7 border-2 border-dashed border-muted-foreground/40">
                  <Loader2 className="size-3 text-muted-foreground animate-spin" />
                </div>
              )}
              <span className={cn(
                "mt-1 text-[10px] tabular-nums whitespace-nowrap",
                isError ? "text-destructive" : isComplete ? "text-muted-foreground" : "text-muted-foreground/50",
              )}>
                {endEvent ? formatTime(endEvent.ts) : "pending"}
              </span>
            </div>
          </div>

          {/* Error messages below timeline */}
          {error && (
            <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {errorEvents.map((ev, i) => (
            <div key={i} className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {(ev.data?.error as string) ?? ev.msg}
            </div>
          ))}

          {/* Phase detail — shown when a timeline node is clicked */}
          {focusedPhase && (
            <PhaseDetail
              phase={focusedPhase}
              events={events}
              onClose={() => setFocusedPhase(null)}
            />
          )}
        </div>

        {/* ── Expandable raw events ── */}
        {events.length > 0 && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              aria-controls={`raw-events-${startEvent?.requestId?.slice(0, 8) ?? "unknown"}`}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
              <div id={`raw-events-${startEvent?.requestId?.slice(0, 8) ?? "unknown"}`} className="border-t border-border bg-muted/20 px-3 py-2 space-y-1">
                {events.map((event, i) => (
                  <RawEventLine key={`${event.ts}-${i}`} event={event} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
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
// Group renderer
// ---------------------------------------------------------------------------

function EventGroup({
  events,
  defaultExpanded,
}: {
  events: LogEvent[];
  defaultExpanded: boolean;
}) {
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
  // "pinned to top" means user is at scrollTop ≈ 0 and wants to see newest
  const pinnedRef = useRef(true);
  const prevScrollHeightRef = useRef(0);

  const handleLevelChange = useCallback(
    (newLevel: LogLevel) => {
      setLevel(newLevel);
      setStreamLevel(newLevel);
    },
    [setStreamLevel],
  );

  // Newest-first: new items prepend at top. When pinned, keep scrollTop at 0.
  // When NOT pinned, compensate scrollTop so the user's view doesn't jump.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (pinnedRef.current) {
      // Stay at top — newest items are already at position 0
      el.scrollTop = 0;
    } else {
      // Content was prepended: the scroll container grew at the top.
      // Compensate so the user's current view stays in place.
      const growth = el.scrollHeight - prevScrollHeightRef.current;
      if (growth > 0) {
        el.scrollTop += growth;
      }
    }
    prevScrollHeightRef.current = el.scrollHeight;
  }, [events.length]);

  // Track whether user is pinned to top
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    pinnedRef.current = scrollRef.current.scrollTop < 30;
  }, []);

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    pinnedRef.current = true;
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

  // Show FAB when not pinned
  const [showFab, setShowFab] = useState(false);
  const handleScrollForFab = useCallback(() => {
    if (!scrollRef.current) return;
    setShowFab(scrollRef.current.scrollTop >= 100);
  }, []);

  const onScroll = useCallback(() => {
    handleScroll();
    handleScrollForFab();
  }, [handleScroll, handleScrollForFab]);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 md:gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold font-display">Logs</h1>
          <ConnectionIndicator connected={connected} />
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-28 md:w-48 text-xs"
          />
          <LevelSelect value={level} onChange={handleLevelChange} />
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={() => setPaused(!paused)}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? (
              <>
                <Play className="size-3" />
                <span className="hidden sm:inline">Resume</span>
              </>
            ) : (
              <>
                <Pause className="size-3" />
                <span className="hidden sm:inline">Pause</span>
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={clear}
            title="Clear"
          >
            <Trash2 className="size-3" />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        </div>
      </div>

      {/* Pause banner */}
      {paused && (
        <div className="flex shrink-0 items-center gap-2 rounded-md bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <Pause className="size-3" />
          Paused — new events are being buffered
        </div>
      )}

      {/* ── Main body: left stats | right stream ── */}
      <div className="min-h-0 flex-1 flex flex-col lg:flex-row gap-3">
        {/* Left — Stats panel (scrollable on desktop, collapsible on mobile) */}
        <LogsStats events={events} />

        {/* Right — Log stream */}
        <div className="relative min-h-0 flex-1 flex flex-col">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto"
          >
            {groups.length === 0 ? (
              <div className="flex h-32 items-center justify-center rounded-md bg-secondary text-sm text-muted-foreground">
                {connected
                  ? "Waiting for log events..."
                  : "Connecting to log stream..."}
              </div>
            ) : (
              <div className="space-y-2 pb-2">
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

          {/* FAB — scroll to top (newest) */}
          {showFab && (
            <button
              type="button"
              onClick={scrollToTop}
              className="absolute bottom-4 right-4 flex items-center justify-center size-10 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-105 active:scale-95"
              title="Back to latest"
            >
              <Rocket className="size-4" />
            </button>
          )}

          {/* Footer status */}
          <div className="flex shrink-0 items-center justify-between pt-2 text-xs text-muted-foreground">
            <span>
              {filteredEvents.length} events
              {search && ` (filtered from ${events.length})`}
            </span>
            <span>{relativeTime(events[events.length - 1]?.ts ?? Date.now())}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
