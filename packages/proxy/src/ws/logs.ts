// ---------------------------------------------------------------------------
// WebSocket handler for real-time log streaming.
//
// Uses Bun's native ServerWebSocket (not Hono WS adapter) for direct
// access to upgrade semantics and per-connection state.
//
// Protocol:
//   - Client connects to /ws/logs?token=<api-key>&level=<min-level>
//   - Server sends backfill from ring buffer, then streams new events
//   - Client can send JSON commands to adjust filtering:
//     { type: "set_level", level: "debug" }
//     { type: "set_filter", requestId: "..." }  // filter to single request
//     { type: "set_filter" }                     // clear filter
// ---------------------------------------------------------------------------

import type { ServerWebSocket } from "bun";
import { logEmitter } from "../util/log-emitter.ts";
import { LEVEL_ORDER, type LogEvent, type LogLevel } from "../util/log-event.ts";

export interface WsData {
  minLevel: LogLevel;
  filterRequestId?: string;
}

function shouldSend(event: LogEvent, data: WsData): boolean {
  if (LEVEL_ORDER[event.level] < LEVEL_ORDER[data.minLevel]) return false;
  if (data.filterRequestId && event.requestId !== data.filterRequestId) return false;
  return true;
}

export const wsHandler = {
  open(ws: ServerWebSocket<WsData>) {
    // Push backfill from ring buffer
    const recent = logEmitter.getRecent();
    for (const event of recent) {
      if (shouldSend(event, ws.data)) {
        ws.send(JSON.stringify(event));
      }
    }

    // Subscribe to new events
    const listener = (event: LogEvent) => {
      if (!shouldSend(event, ws.data)) return;
      ws.send(JSON.stringify(event));
    };
    logEmitter.on("log", listener);
    // Store listener ref for cleanup — Bun WS doesn't have a generic data slot
    // beyond ws.data, so we use a WeakMap.
    listenerMap.set(ws, listener);
  },

  close(ws: ServerWebSocket<WsData>) {
    const listener = listenerMap.get(ws);
    if (listener) {
      logEmitter.off("log", listener);
      listenerMap.delete(ws);
    }
  },

  message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
    try {
      const cmd = JSON.parse(typeof msg === "string" ? msg : msg.toString());
      if (cmd.type === "set_level" && cmd.level in LEVEL_ORDER) {
        ws.data.minLevel = cmd.level;
      }
      if (cmd.type === "set_filter") {
        ws.data.filterRequestId = cmd.requestId ?? undefined;
      }
    } catch {
      // Ignore malformed messages
    }
  },
};

// WeakMap to track listener per WS connection for cleanup
const listenerMap = new WeakMap<
  ServerWebSocket<WsData>,
  (event: LogEvent) => void
>();
