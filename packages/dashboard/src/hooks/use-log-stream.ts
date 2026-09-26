"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types — mirrors LogEvent from proxy (packages/proxy/src/util/log-event.ts)
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEventType =
  | "system"
  | "request_start"
  | "request_end"
  | "sse_chunk"
  | "upstream_raw_sse"
  | "upstream_error";

export interface LogEvent {
  ts: number;
  level: LogLevel;
  type: LogEventType;
  requestId?: string | null;
  msg: string;
  data?: Record<string, unknown> | null;
  /**
   * Client-assigned monotonic sequence number, unique within the hook's
   * lifetime. Stable across renders and unaffected by ring-buffer
   * eviction. Consumers should key React lists off `_seq` rather than
   * `ts` (which can collide within the same millisecond) or the array
   * index (which shifts when the oldest event is evicted).
   *
   * Optional so tests and other synthetic LogEvent constructors don't
   * need to invent a counter — the hook itself always populates it.
   */
  _seq?: number;
}

// ---------------------------------------------------------------------------
// Hook options & return
// ---------------------------------------------------------------------------

interface UseLogStreamOptions {
  level?: LogLevel;
  requestId?: string;
  maxEvents?: number;
  enabled?: boolean;
  /**
   * Called synchronously in the SSE listener BEFORE the state update
   * that appends the new event. This is the only point where the
   * previous commit's DOM is guaranteed to still be on screen — React
   * hasn't scheduled the re-render yet — so consumers that need a
   * pre-commit snapshot (e.g. capturing a scroll anchor) must do it
   * here, not in a render body or useLayoutEffect. Called once per
   * accepted live event, and once per event flushed from the pause
   * buffer. Not called for events dropped due to malformed JSON.
   */
  onBeforeAppend?: () => void;
}

interface UseLogStreamReturn {
  events: LogEvent[];
  /**
   * Monotonically increments on every event append. Consumers that need to
   * re-run an effect on each new event should depend on `eventSeq` instead
   * of `events.length` — length saturates once the ring buffer is full and
   * ts can collide within the same millisecond, so neither is a reliable
   * change trigger on its own.
   */
  eventSeq: number;
  connected: boolean;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  clear: () => void;
  setLevel: (level: LogLevel) => void;
}

const MAX_EVENTS_DEFAULT = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// ---------------------------------------------------------------------------
// useLogStream — connects to BFF SSE at /api/logs/stream
// ---------------------------------------------------------------------------

export function useLogStream(
  options: UseLogStreamOptions = {},
): UseLogStreamReturn {
  const {
    level: initialLevel = "info",
    requestId,
    maxEvents = MAX_EVENTS_DEFAULT,
    enabled = true,
    onBeforeAppend,
  } = options;

  const [events, setEvents] = useState<LogEvent[]>([]);
  const [eventSeq, setEventSeq] = useState(0);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<LogLevel>(initialLevel);

  // Refs for values accessed inside the SSE listener closure
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Latest onBeforeAppend closure. Kept in a ref so changing it
  // (which the consumer will do every render — new anchor-capture
  // closure per state) does NOT tear down the SSE connection.
  const onBeforeAppendRef = useRef(onBeforeAppend);
  onBeforeAppendRef.current = onBeforeAppend;

  // Buffers for pause mode
  const pauseBufferRef = useRef<LogEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id for `_seq`. Lives outside React state so it advances
  // exactly once per accepted event even when React batches updates
  // or when strict-mode re-invokes the setter.
  const seqCounterRef = useRef(0);

  const stampEvent = useCallback((raw: LogEvent): LogEvent => {
    seqCounterRef.current += 1;
    return { ...raw, _seq: seqCounterRef.current };
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
    setEventSeq((n) => n + 1);
    pauseBufferRef.current = [];
  }, []);

  // Flush pause buffer when unpausing
  useEffect(() => {
    if (!paused && pauseBufferRef.current.length > 0) {
      const buffered = pauseBufferRef.current;
      pauseBufferRef.current = [];
      try {
        onBeforeAppendRef.current?.();
      } catch {
        // Ignore consumer-side snapshot errors
      }
      setEvents((prev) => {
        const combined = [...prev, ...buffered];
        return combined.length > maxEvents
          ? combined.slice(-maxEvents)
          : combined;
      });
      setEventSeq((n) => n + buffered.length);
    }
  }, [paused, maxEvents]);

  // Main SSE connection effect
  useEffect(() => {
    if (!enabled) return;

    function connect() {
      // Build URL with params
      const params = new URLSearchParams({ level });
      if (requestId) params.set("requestId", requestId);
      const url = `/api/logs/stream?${params}`;

      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.addEventListener("connected", () => {
        setConnected(true);
        reconnectAttemptRef.current = 0;
      });

      es.addEventListener("log", (e) => {
        try {
          const raw: LogEvent = JSON.parse(e.data);
          const event = stampEvent(raw);
          if (pausedRef.current) {
            // If paused, buffer events for later flush
            pauseBufferRef.current.push(event);
          } else {
            // Give the consumer a chance to snapshot the pre-commit
            // DOM BEFORE we schedule the re-render. Any throw is
            // swallowed — a broken snapshot callback must not drop
            // the log event.
            try {
              onBeforeAppendRef.current?.();
            } catch {
              // Ignore consumer-side snapshot errors
            }
            setEvents((prev) => {
              const next = [...prev, event];
              return next.length > maxEvents ? next.slice(-maxEvents) : next;
            });
            setEventSeq((n) => n + 1);
          }
        } catch {
          // Ignore malformed events
        }
      });

      es.addEventListener("disconnected", () => {
        setConnected(false);
        es.close();
        scheduleReconnect();
      });

      es.addEventListener("error", () => {
        // Native EventSource fires error on connection loss.
        // Close immediately to prevent native auto-reconnect, then use
        // our own backoff-based reconnect exclusively.
        setConnected(false);
        es.close();
        scheduleReconnect();
      });
    }

    function scheduleReconnect() {
      // Guard against duplicate calls (e.g. both "disconnected" and "error"
      // firing for the same EventSource instance)
      if (reconnectTimerRef.current) return;
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** attempt,
        RECONNECT_MAX_MS,
      );
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setConnected(false);
    };
    // Re-connect when level or requestId changes
  }, [enabled, level, requestId, maxEvents, stampEvent]);

  return {
    events,
    eventSeq,
    connected,
    paused,
    setPaused,
    clear,
    setLevel,
  };
}
