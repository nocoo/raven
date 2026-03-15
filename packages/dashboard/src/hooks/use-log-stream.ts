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
  | "upstream_error";

export interface LogEvent {
  ts: number;
  level: LogLevel;
  type: LogEventType;
  requestId?: string;
  msg: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Hook options & return
// ---------------------------------------------------------------------------

interface UseLogStreamOptions {
  level?: LogLevel;
  requestId?: string;
  maxEvents?: number;
  enabled?: boolean;
}

interface UseLogStreamReturn {
  events: LogEvent[];
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
  } = options;

  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<LogLevel>(initialLevel);

  // Refs for values accessed inside the SSE listener closure
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Buffers for pause mode
  const pauseBufferRef = useRef<LogEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    setEvents([]);
    pauseBufferRef.current = [];
  }, []);

  // Flush pause buffer when unpausing
  useEffect(() => {
    if (!paused && pauseBufferRef.current.length > 0) {
      const buffered = pauseBufferRef.current;
      pauseBufferRef.current = [];
      setEvents((prev) => {
        const combined = [...prev, ...buffered];
        return combined.length > maxEvents
          ? combined.slice(-maxEvents)
          : combined;
      });
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
          const event: LogEvent = JSON.parse(e.data);
          if (pausedRef.current) {
            // If paused, buffer events for later flush
            pauseBufferRef.current.push(event);
          } else {
            setEvents((prev) => {
              const next = [...prev, event];
              return next.length > maxEvents ? next.slice(-maxEvents) : next;
            });
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
        RECONNECT_BASE_MS * Math.pow(2, attempt),
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
  }, [enabled, level, requestId, maxEvents]);

  return {
    events,
    connected,
    paused,
    setPaused,
    clear,
    setLevel,
  };
}
