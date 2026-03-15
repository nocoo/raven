import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { LogEvent } from "../../src/util/log-event.ts";
import { logEmitter } from "../../src/util/log-emitter.ts";
import { wsHandler, type WsData } from "../../src/ws/logs.ts";

// ---------------------------------------------------------------------------
// Mock ServerWebSocket
// ---------------------------------------------------------------------------

function createMockWs(data: WsData): ServerWebSocket<WsData> & { sent: string[] } {
  const sent: string[] = [];
  return {
    data,
    sent,
    send: mock((msg: string) => {
      sent.push(msg);
      return msg.length;
    }),
    close: mock(),
    // Minimal stub — only the fields wsHandler uses
  } as unknown as ServerWebSocket<WsData> & { sent: string[] };
}

function makeEvent(overrides?: Partial<LogEvent>): LogEvent {
  return {
    ts: Date.now(),
    level: "info",
    type: "system",
    msg: "test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wsHandler", () => {
  beforeEach(() => {
    logEmitter.clearBuffer();
    logEmitter.removeAllListeners("log");
  });

  describe("open", () => {
    test("sends backfill from ring buffer", () => {
      logEmitter.emitLog(makeEvent({ msg: "old-1" }));
      logEmitter.emitLog(makeEvent({ msg: "old-2" }));

      const ws = createMockWs({ minLevel: "info" });
      wsHandler.open(ws);

      // Should have received 2 backfill messages
      expect(ws.sent).toHaveLength(2);
      expect(JSON.parse(ws.sent[0]).msg).toBe("old-1");
      expect(JSON.parse(ws.sent[1]).msg).toBe("old-2");
    });

    test("filters backfill by minLevel", () => {
      logEmitter.emitLog(makeEvent({ level: "debug", msg: "debug" }));
      logEmitter.emitLog(makeEvent({ level: "info", msg: "info" }));
      logEmitter.emitLog(makeEvent({ level: "error", msg: "error" }));

      const ws = createMockWs({ minLevel: "warn" });
      wsHandler.open(ws);

      // Only error should pass (warn level filters out debug + info)
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).msg).toBe("error");
    });

    test("subscribes to new events after open", () => {
      const ws = createMockWs({ minLevel: "info" });
      wsHandler.open(ws);

      // Emit after open
      logEmitter.emitLog(makeEvent({ msg: "live" }));

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).msg).toBe("live");
    });

    test("filters live events by minLevel", () => {
      const ws = createMockWs({ minLevel: "warn" });
      wsHandler.open(ws);

      logEmitter.emitLog(makeEvent({ level: "debug", msg: "debug" }));
      logEmitter.emitLog(makeEvent({ level: "info", msg: "info" }));
      logEmitter.emitLog(makeEvent({ level: "warn", msg: "warn" }));

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).msg).toBe("warn");
    });

    test("filters live events by requestId", () => {
      const ws = createMockWs({ minLevel: "info", filterRequestId: "req-1" });
      wsHandler.open(ws);

      logEmitter.emitLog(makeEvent({ requestId: "req-1", msg: "match" }));
      logEmitter.emitLog(makeEvent({ requestId: "req-2", msg: "no-match" }));
      logEmitter.emitLog(makeEvent({ msg: "no-id" }));

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).msg).toBe("match");
    });
  });

  describe("close", () => {
    test("unsubscribes listener on close", () => {
      const ws = createMockWs({ minLevel: "info" });
      wsHandler.open(ws);

      // Verify listener is active
      logEmitter.emitLog(makeEvent({ msg: "before" }));
      expect(ws.sent).toHaveLength(1);

      wsHandler.close(ws);

      // After close, should not receive new events
      logEmitter.emitLog(makeEvent({ msg: "after" }));
      expect(ws.sent).toHaveLength(1); // Still 1
    });
  });

  describe("message", () => {
    test("set_level command changes minLevel", () => {
      const ws = createMockWs({ minLevel: "info" });
      wsHandler.open(ws);

      // Debug events should be filtered at info level
      logEmitter.emitLog(makeEvent({ level: "debug", msg: "hidden" }));
      expect(ws.sent).toHaveLength(0);

      // Change level to debug
      wsHandler.message(ws, JSON.stringify({ type: "set_level", level: "debug" }));

      logEmitter.emitLog(makeEvent({ level: "debug", msg: "visible" }));
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).msg).toBe("visible");
    });

    test("set_filter command sets requestId filter", () => {
      const ws = createMockWs({ minLevel: "info" });
      wsHandler.open(ws);

      // Set filter
      wsHandler.message(ws, JSON.stringify({ type: "set_filter", requestId: "req-x" }));

      logEmitter.emitLog(makeEvent({ requestId: "req-x", msg: "match" }));
      logEmitter.emitLog(makeEvent({ requestId: "req-y", msg: "no-match" }));

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).msg).toBe("match");
    });

    test("set_filter without requestId clears filter", () => {
      const ws = createMockWs({ minLevel: "info", filterRequestId: "req-x" });
      wsHandler.open(ws);

      // Clear filter
      wsHandler.message(ws, JSON.stringify({ type: "set_filter" }));

      logEmitter.emitLog(makeEvent({ requestId: "req-y", msg: "now-visible" }));
      expect(ws.sent).toHaveLength(1);
    });

    test("ignores malformed messages", () => {
      const ws = createMockWs({ minLevel: "info" });
      wsHandler.open(ws);

      // Should not throw
      wsHandler.message(ws, "not json");
      wsHandler.message(ws, "{}");
      wsHandler.message(ws, JSON.stringify({ type: "unknown" }));

      expect(ws.data.minLevel).toBe("info");
    });

    test("rejects invalid level values", () => {
      const ws = createMockWs({ minLevel: "info" });
      wsHandler.open(ws);

      wsHandler.message(ws, JSON.stringify({ type: "set_level", level: "invalid" }));
      expect(ws.data.minLevel).toBe("info"); // Unchanged
    });
  });
});
