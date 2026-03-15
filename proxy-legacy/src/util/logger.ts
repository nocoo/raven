// ---------------------------------------------------------------------------
// Terminal sink — subscribes to LogEmitter and outputs JSON lines to stdout.
//
// Also exposes the convenience `logger.debug/info/warn/error()` API which
// emits "system" type LogEvents through the emitter. Callers that need a
// specific LogEventType should use `logEmitter.emitLog()` directly.
// ---------------------------------------------------------------------------

import { logEmitter } from "./log-emitter.ts";
import { LEVEL_ORDER, type LogEvent, type LogLevel } from "./log-event.ts";

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

logEmitter.on("log", (event: LogEvent) => {
  if (!shouldLog(event.level)) return;

  const line = JSON.stringify({
    ts: new Date(event.ts).toISOString(),
    level: event.level,
    type: event.type,
    msg: event.msg,
    ...(event.requestId && { requestId: event.requestId }),
    ...(event.data && Object.keys(event.data).length > 0 && event.data),
  });

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
});

// ---------------------------------------------------------------------------
// Convenience API — emits "system" type events through LogEmitter
// ---------------------------------------------------------------------------

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    logEmitter.emitLog({ ts: Date.now(), level: "debug", type: "system", msg, data }),
  info: (msg: string, data?: Record<string, unknown>) =>
    logEmitter.emitLog({ ts: Date.now(), level: "info", type: "system", msg, data }),
  warn: (msg: string, data?: Record<string, unknown>) =>
    logEmitter.emitLog({ ts: Date.now(), level: "warn", type: "system", msg, data }),
  error: (msg: string, data?: Record<string, unknown>) =>
    logEmitter.emitLog({ ts: Date.now(), level: "error", type: "system", msg, data }),
};
