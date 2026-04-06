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
 * Shorten model name by stripping trailing date patterns:
 *   "claude-3-5-sonnet-20241022"   → "claude-3-5-sonnet"
 *   "claude-sonnet-4-20250514"     → "claude-sonnet-4"
 *   "gpt-5.4-2026-03-05"          → "gpt-5.4"
 *   "gpt-4o"                       → "gpt-4o" (no date to strip)
 *   "o3-mini"                      → "o3-mini"
 */
export function shortenModel(model: string): string {
  // Strip trailing -YYYYMMDD (e.g. -20241022)
  return model.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/**
 * Extract a short session identifier.
 * - "::" format (e.g. "user123::Claude Code::default") → first segment, first 6 chars
 * - "_" format (e.g. "user_abc_a885da1234") → last segment after `_`, first 6 chars
 * - Fallback → first 6 characters
 */
export function shortenSession(id: string): string {
  if (id.includes("::")) {
    const parts = id.split("::");
    const part = parts[0];
    if (part) return part.slice(0, 6);
    return "unknown";
  }
  const parts = id.split("_");
  const last = parts.at(-1);
  if (last) return last.slice(0, 6);
  return "unknown";
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
      return formatRequestEnd(time, data);

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
  data: Record<string, unknown>,
): string {
  const statusCode = data.statusCode as number | null | undefined;
  const isError = data.status === "error" || (statusCode !== null && statusCode !== undefined && statusCode >= 400);
  // Prefer resolvedModel (actual model used) over model (request alias)
  const model = cyan(bold(shortenModel(String(data.resolvedModel ?? data.model ?? "unknown"))));

  if (isError) {
    return formatRequestEndError(time, data, model, statusCode ?? null);
  }
  return formatRequestEndSuccess(time, data, model, statusCode ?? null);
}

function formatRequestEndSuccess(
  time: string,
  data: Record<string, unknown>,
  model: string,
  statusCode: number | null,
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

/**
 * Extract the meaningful error message from a potentially JSON-wrapped error.
 *
 * Handles formats like:
 *   "Failed to create chat completions: {"error":{"message":"The real error"}}"
 *   → "The real error"
 *
 * Falls back to truncating the raw message if not JSON.
 */
function truncateError(msg: string, maxLen = 80): string {
  // Try to extract JSON error message from pattern: "prefix: {json}"
  const jsonStart = msg.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const jsonPart = msg.slice(jsonStart);
      const parsed = JSON.parse(jsonPart);
      // OpenAI/Anthropic style: { "error": { "message": "..." } }
      if (parsed?.error?.message) {
        const extracted = String(parsed.error.message);
        if (extracted.length <= maxLen) return extracted;
        return `${extracted.slice(0, maxLen)}…`;
      }
      // Simple style: { "message": "..." }
      if (parsed?.message) {
        const extracted = String(parsed.message);
        if (extracted.length <= maxLen) return extracted;
        return `${extracted.slice(0, maxLen)}…`;
      }
    } catch {
      // Not valid JSON, fall through to plain truncation
    }
  }

  // Strip "For more information, ..." suffix from Bun fetch errors
  const cleaned = msg.replace(/\.?\s*For more information,.*$/i, "");
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen)}…`;
}

function formatRequestEndError(
  time: string,
  data: Record<string, unknown>,
  model: string,
  statusCode: number | null,
): string {
  const status = red(String(statusCode ?? "err"));
  const dur = formatDuration(Number(data.latencyMs ?? 0));
  const errorMsg = data.error ? dim(truncateError(String(data.error))) : "";
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
