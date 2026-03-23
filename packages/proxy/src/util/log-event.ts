// ---------------------------------------------------------------------------
// Structured log event types — shared across all sinks (terminal, WS, DB)
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type LogEventType =
  | "system"          // init, token refresh, config change
  | "request_start"   // request enters proxy
  | "request_end"     // request complete (status, latency, token usage)
  | "sse_chunk"       // upstream SSE chunk (translated or passthrough)
  | "upstream_error"; // upstream non-2xx or network error

export interface LogEvent {
  ts: number;            // Date.now(), unix ms
  level: LogLevel;
  type: LogEventType;
  requestId: string | null;    // correlates all events for one request
  msg: string;           // human-readable summary
  data?: Record<string, unknown> | null;
}
