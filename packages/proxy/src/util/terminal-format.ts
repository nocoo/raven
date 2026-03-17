// ---------------------------------------------------------------------------
// Pretty terminal log formatter — converts LogEvent into colorized one-liners.
//
// Only used by the terminal sink. WebSocket and DB sinks remain unchanged.
// Respects NO_COLOR (https://no-color.org).
// ---------------------------------------------------------------------------

import type { LogEvent } from "./log-event.ts";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const useColor = !process.env.NO_COLOR;

const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[22m` : s);
const green = (s: string) => (useColor ? `\x1b[32m${s}\x1b[39m` : s);
const red = (s: string) => (useColor ? `\x1b[31m${s}\x1b[39m` : s);
const yellow = (s: string) => (useColor ? `\x1b[33m${s}\x1b[39m` : s);
const cyan = (s: string) => (useColor ? `\x1b[36m${s}\x1b[39m` : s);

// ---------------------------------------------------------------------------
// Utility functions (exported for testing)
// ---------------------------------------------------------------------------

/** Format unix-ms timestamp to "HH:MM:SS" local time. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Shorten model name by stripping common prefixes:
 *   "claude-3-5-sonnet-20241022" → "3-5-sonnet-20241022"
 *   "claude-sonnet-4-20250514"   → "sonnet-4-20250514"
 *   "gpt-4o"                     → "4o"
 *   "o3-mini"                    → "o3-mini" (no prefix to strip)
 */
export function shortenModel(model: string): string {
  if (model.startsWith("claude-")) return model.slice(7);
  if (model.startsWith("gpt-")) return model.slice(4);
  return model;
}

/**
 * Extract a short session identifier.
 * Session IDs are typically "user_xxx_yyy_abc123def456..." — we take the
 * last segment after `_` and return the first 6 characters.
 * Falls back to first 6 characters if no underscore.
 */
export function shortenSession(id: string): string {
  const parts = id.split("_");
  const last = parts[parts.length - 1];
  return last.slice(0, 6);
}

/**
 * Format duration in ms to human-readable:
 *   ≥1000 → "7.5s"  (one decimal)
 *   <1000 → "350ms"
 */
export function formatDuration(ms: number): string {
  if (ms >= 1000) {
    const seconds = ms / 1000;
    // Avoid trailing .0 for whole seconds
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format a LogEvent into a pretty terminal line.
 * Returns `null` for event types that should be suppressed (e.g. sse_chunk).
 */
export function formatEvent(event: LogEvent): string | null {
  const time = dim(formatTime(event.ts));
  const data = event.data ?? {};

  switch (event.type) {
    case "system":
      return formatSystem(time, event);

    case "request_start":
      return formatRequestStart(time, data);

    case "request_end":
      return formatRequestEnd(time, event, data);

    case "upstream_error":
      return formatUpstreamError(time, event, data);

    case "sse_chunk":
      // Too noisy for terminal — debug-only via WS
      return null;

    default:
      // Unknown event type — fall back to simple format
      return `${time} ${event.msg}`;
  }
}

// ---------------------------------------------------------------------------
// Per-type formatters
// ---------------------------------------------------------------------------

function formatSystem(time: string, event: LogEvent): string {
  const levelTag = formatLevelTag(event.level);
  return `${time} ${levelTag}  ${event.msg}`;
}

function formatRequestStart(
  time: string,
  data: Record<string, unknown>,
): string {
  const model = cyan(bold(shortenModel(String(data.model ?? "unknown"))));
  const streamTag = data.stream ? "stream" : "sync";
  const client = dim(String(data.clientName ?? ""));
  const session = data.sessionId
    ? dim(`(${shortenSession(String(data.sessionId))})`)
    : "";

  const parts = [time, green("──▶"), model, dim(streamTag)];
  if (client) parts.push(client);
  if (session) parts.push(session);
  return parts.join("  ");
}

function formatRequestEnd(
  time: string,
  event: LogEvent,
  data: Record<string, unknown>,
): string {
  const statusCode = data.statusCode as number | undefined;
  const isError = data.status === "error" || (statusCode && statusCode >= 400);
  const model = cyan(bold(shortenModel(String(data.model ?? "unknown"))));

  if (isError) {
    return formatRequestEndError(time, data, model, statusCode);
  }
  return formatRequestEndSuccess(time, data, model, statusCode);
}

function formatRequestEndSuccess(
  time: string,
  data: Record<string, unknown>,
  model: string,
  statusCode: number | undefined,
): string {
  const status = green(String(statusCode ?? 200));
  const dur = formatDuration(Number(data.latencyMs ?? 0));
  const ttft =
    data.ttftMs != null ? `ttft ${formatDuration(Number(data.ttftMs))}` : "";
  const inputTok = data.inputTokens ?? 0;
  const outputTok = data.outputTokens ?? 0;
  const tokens = dim(`${inputTok}→${outputTok} tok`);
  const client = dim(String(data.clientName ?? ""));
  const session = data.sessionId
    ? dim(`(${shortenSession(String(data.sessionId))})`)
    : "";

  const parts = [time, green("◀──"), model, status, dim(dur)];
  if (ttft) parts.push(dim(ttft));
  parts.push(tokens);
  if (client) parts.push(client);
  if (session) parts.push(session);
  return parts.join("  ");
}

function formatRequestEndError(
  time: string,
  data: Record<string, unknown>,
  model: string,
  statusCode: number | undefined,
): string {
  const status = red(String(statusCode ?? "err"));
  const dur = formatDuration(Number(data.latencyMs ?? 0));
  const errorMsg = data.error ? dim(String(data.error)) : "";
  const client = dim(String(data.clientName ?? ""));
  const session = data.sessionId
    ? dim(`(${shortenSession(String(data.sessionId))})`)
    : "";

  const parts = [time, red("✗──"), model, status, dim(dur)];
  if (errorMsg) parts.push(errorMsg);
  if (client) parts.push(client);
  if (session) parts.push(session);
  return parts.join("  ");
}

function formatUpstreamError(
  time: string,
  event: LogEvent,
  data: Record<string, unknown>,
): string {
  const errorDetail = data.error ? `: ${data.error}` : "";
  return `${time} ${red("ERR")}  ${event.msg}${errorDetail}`;
}

function formatLevelTag(level: string): string {
  switch (level) {
    case "debug":
      return dim("DBG");
    case "info":
      return green("INF");
    case "warn":
      return yellow("WRN");
    case "error":
      return red("ERR");
    default:
      return level.toUpperCase();
  }
}
