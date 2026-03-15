// ---------------------------------------------------------------------------
// Central event bus for structured log events.
//
// All log events flow through this emitter. Sinks (terminal, WebSocket)
// subscribe via .on("log", ...). A ring buffer retains recent events for
// WS client backfill on connect.
//
// IMPORTANT: EventEmitter dispatches synchronously — every listener's cost
// is added to the caller's hot path. Listeners MUST be lightweight:
//   - Terminal sink: JSON.stringify + console.* (gated by level)
//   - WS sink: ws.send() (Bun copies to kernel buffer, non-blocking)
//   - Level check happens BEFORE serialization to avoid wasted work
// ---------------------------------------------------------------------------

import { EventEmitter } from "events";
import type { LogEvent } from "./log-event.ts";

const DEFAULT_BUFFER_SIZE = 200;

class LogEmitter extends EventEmitter {
  private ringBuffer: LogEvent[] = [];
  private maxBufferSize: number;

  constructor(bufferSize?: number) {
    super();
    this.maxBufferSize = bufferSize ?? DEFAULT_BUFFER_SIZE;
    // Avoid MaxListenersExceededWarning for many WS clients
    this.setMaxListeners(100);
  }

  /** Emit a log event to all listeners and store in ring buffer. */
  emitLog(event: LogEvent): void {
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.maxBufferSize) {
      this.ringBuffer.shift();
    }
    this.emit("log", event);
  }

  /** Get a snapshot of the ring buffer (for WS backfill). */
  getRecent(): LogEvent[] {
    return [...this.ringBuffer];
  }

  /** Current ring buffer size (for testing). */
  get bufferSize(): number {
    return this.ringBuffer.length;
  }

  /** Clear the ring buffer (for testing). */
  clearBuffer(): void {
    this.ringBuffer.length = 0;
  }
}

const bufferSize = parseInt(process.env.RAVEN_LOG_BUFFER_SIZE ?? "", 10);
export const logEmitter = new LogEmitter(
  Number.isFinite(bufferSize) && bufferSize > 0 ? bufferSize : undefined,
);
