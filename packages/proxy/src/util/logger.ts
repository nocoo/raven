// ---------------------------------------------------------------------------
// Terminal sink — subscribes to LogEmitter and outputs JSON lines to stdout.
//
// Also exposes the convenience `logger.debug/info/warn/error()` API which
// emits "system" type LogEvents through the emitter. Callers that need a
// specific LogEventType should use `logEmitter.emitLog()` directly.
// ---------------------------------------------------------------------------

import { logEmitter } from "./log-emitter.ts";
import { LEVEL_ORDER, type LogEvent, type LogLevel } from "./log-event.ts";
import { formatEvent } from "./terminal-format.ts";

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

// ---------------------------------------------------------------------------
// Terminal sink listener — gated by currentLevel BEFORE serialization
// ---------------------------------------------------------------------------

function terminalSinkListener(event: LogEvent): void {
  if (!shouldLog(event.level)) return;

  const line = formatEvent(event);
  if (!line) return; // sse_chunk returns null — skip

  switch (event.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

let terminalSinkEnabled = false;

/** Enable terminal log output. Called at application startup. */
export function enableTerminalSink(): void {
  if (terminalSinkEnabled) return;
  logEmitter.on("log", terminalSinkListener);
  terminalSinkEnabled = true;
}

/** Disable terminal log output. Useful in tests to silence noise. */
export function disableTerminalSink(): void {
  if (!terminalSinkEnabled) return;
  logEmitter.off("log", terminalSinkListener);
  terminalSinkEnabled = false;
}

// Auto-enable outside of test environment
if (!process.env.BUN_TEST && process.env.NODE_ENV !== "test") {
  enableTerminalSink();
}

// ---------------------------------------------------------------------------
// Convenience API — emits "system" type events through LogEmitter
//
// PERFORMANCE: Level check happens BEFORE object creation to avoid
// allocating event objects that will be immediately discarded.
// ---------------------------------------------------------------------------

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => {
    if (!shouldLog("debug")) return;
    logEmitter.emitLog({ ts: Date.now(), level: "debug", type: "system", msg, requestId: null, ...(data !== undefined && { data }) });
  },
  info: (msg: string, data?: Record<string, unknown>) => {
    if (!shouldLog("info")) return;
    logEmitter.emitLog({ ts: Date.now(), level: "info", type: "system", msg, requestId: null, ...(data !== undefined && { data }) });
  },
  warn: (msg: string, data?: Record<string, unknown>) => {
    if (!shouldLog("warn")) return;
    logEmitter.emitLog({ ts: Date.now(), level: "warn", type: "system", msg, requestId: null, ...(data !== undefined && { data }) });
  },
  error: (msg: string, data?: Record<string, unknown>) => {
    if (!shouldLog("error")) return;
    logEmitter.emitLog({ ts: Date.now(), level: "error", type: "system", msg, requestId: null, ...(data !== undefined && { data }) });
  },
};
