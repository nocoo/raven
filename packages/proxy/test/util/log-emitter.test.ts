import { describe, expect, test, beforeEach } from "bun:test";
import type { LogEvent } from "../../src/util/log-event.ts";

// We need a fresh LogEmitter per test — import the class via a workaround
// since the module exports a singleton. We'll test the singleton behavior too.

describe("LogEvent types", () => {
  test("LEVEL_ORDER has correct numeric ordering", async () => {
    const { LEVEL_ORDER } = await import("../../src/util/log-event.ts");
    expect(LEVEL_ORDER.debug).toBeLessThan(LEVEL_ORDER.info);
    expect(LEVEL_ORDER.info).toBeLessThan(LEVEL_ORDER.warn);
    expect(LEVEL_ORDER.warn).toBeLessThan(LEVEL_ORDER.error);
  });
});

describe("LogEmitter", () => {
  // Use dynamic import + clear to get predictable state
  let emitter: Awaited<ReturnType<typeof getEmitter>>;

  async function getEmitter() {
    const mod = await import("../../src/util/log-emitter.ts");
    mod.logEmitter.clearBuffer();
    mod.logEmitter.removeAllListeners("log");
    return mod.logEmitter;
  }

  beforeEach(async () => {
    emitter = await getEmitter();
  });

  function makeEvent(overrides?: Partial<LogEvent>): LogEvent {
    return {
      ts: Date.now(),
      level: "info",
      type: "system",
      requestId: null,
      msg: "test event",
      ...overrides,
    };
  }

  test("emitLog stores events in ring buffer", () => {
    emitter.emitLog(makeEvent({ msg: "first" }));
    emitter.emitLog(makeEvent({ msg: "second" }));

    expect(emitter.bufferSize).toBe(2);
    const recent = emitter.getRecent();
    expect(recent).toHaveLength(2);
    expect(recent[0]!.msg).toBe("first");
    expect(recent[1]!.msg).toBe("second");
  });

  test("ring buffer caps at maxBufferSize", () => {
    // Default is 200, but we can't easily change it on the singleton.
    // Instead, fill past 200 and verify oldest gets evicted.
    for (let i = 0; i < 210; i++) {
      emitter.emitLog(makeEvent({ msg: `event-${i}` }));
    }

    expect(emitter.bufferSize).toBe(200);
    const recent = emitter.getRecent();
    // Oldest 10 should be evicted, first remaining is event-10
    expect(recent[0]!.msg).toBe("event-10");
    expect(recent[199]!.msg).toBe("event-209");
  });

  test("getRecent returns a copy, not a reference", () => {
    emitter.emitLog(makeEvent());
    const a = emitter.getRecent();
    const b = emitter.getRecent();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  test("emitLog dispatches to listeners synchronously", () => {
    const received: LogEvent[] = [];
    emitter.on("log", (event: LogEvent) => received.push(event));

    const event = makeEvent({ msg: "sync-test" });
    emitter.emitLog(event);

    // Listener should have been called synchronously
    expect(received).toHaveLength(1);
    expect(received[0]!.msg).toBe("sync-test");
  });

  test("multiple listeners all receive events", () => {
    const a: string[] = [];
    const b: string[] = [];
    emitter.on("log", (e: LogEvent) => a.push(e.msg));
    emitter.on("log", (e: LogEvent) => b.push(e.msg));

    emitter.emitLog(makeEvent({ msg: "multi" }));

    expect(a).toEqual(["multi"]);
    expect(b).toEqual(["multi"]);
  });

  test("removed listener stops receiving events", () => {
    const received: string[] = [];
    const listener = (e: LogEvent) => received.push(e.msg);
    emitter.on("log", listener);

    emitter.emitLog(makeEvent({ msg: "before" }));
    emitter.off("log", listener);
    emitter.emitLog(makeEvent({ msg: "after" }));

    expect(received).toEqual(["before"]);
  });

  test("clearBuffer empties the ring buffer", () => {
    emitter.emitLog(makeEvent());
    emitter.emitLog(makeEvent());
    expect(emitter.bufferSize).toBe(2);

    emitter.clearBuffer();
    expect(emitter.bufferSize).toBe(0);
    expect(emitter.getRecent()).toEqual([]);
  });

  test("events preserve all fields", () => {
    const event: LogEvent = {
      ts: 1700000000000,
      level: "error",
      type: "upstream_error",
      requestId: "req-123",
      msg: "upstream 502",
      data: { statusCode: 502, body: "bad gateway" },
    };
    emitter.emitLog(event);

    const stored = emitter.getRecent()[0]!;
    expect(stored.ts).toBe(1700000000000);
    expect(stored.level).toBe("error");
    expect(stored.type).toBe("upstream_error");
    expect(stored.requestId).toBe("req-123");
    expect(stored.msg).toBe("upstream 502");
    expect(stored.data).toEqual({ statusCode: 502, body: "bad gateway" });
  });
});
