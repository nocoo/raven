import { describe, expect, it } from "vitest";
import { groupEvents } from "@/app/logs/group-events";
import type { LogEvent } from "@/hooks/use-log-stream";

function ev(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: 1000,
    level: "info",
    type: "system",
    msg: "test",
    ...overrides,
  };
}

describe("groupEvents", () => {
  it("puts system events (no requestId) in standalone groups", () => {
    const groups = groupEvents([
      ev({ _seq: 1, type: "system", msg: "boot" }),
      ev({ _seq: 2, type: "system", msg: "config" }),
    ]);
    // Reversed: newest first
    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).toBe("sys-2");
    expect(groups[1]!.key).toBe("sys-1");
  });

  it("combines events with the same requestId into one group", () => {
    const groups = groupEvents([
      ev({ _seq: 1, type: "request_start", requestId: "r-a", msg: "start" }),
      ev({ _seq: 2, type: "sse_chunk", requestId: "r-a", msg: "chunk" }),
      ev({ _seq: 3, type: "request_end", requestId: "r-a", msg: "end" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("r-a");
    expect(groups[0]!.events).toHaveLength(3);
    expect(groups[0]!.events.map((e) => e.msg)).toEqual(["start", "chunk", "end"]);
  });

  it("keeps groups newest-first while preserving intra-group order", () => {
    const groups = groupEvents([
      ev({ _seq: 1, requestId: "r-a", msg: "a-start" }),
      ev({ _seq: 2, requestId: "r-b", msg: "b-start" }),
      ev({ _seq: 3, requestId: "r-a", msg: "a-end" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["r-b", "r-a"]);
    // Intra-group order is chronological, not reversed
    expect(groups[1]!.events.map((e) => e.msg)).toEqual(["a-start", "a-end"]);
  });

  it("produces stable keys across successive calls with the same events", () => {
    const events = [ev({ _seq: 5, msg: "sys" }), ev({ _seq: 6, requestId: "r-a", msg: "req" })];
    const first = groupEvents(events).map((g) => g.key);
    const second = groupEvents(events).map((g) => g.key);
    expect(first).toEqual(second);
    // No Math.random() leakage — should be deterministic, not just equal
    expect(first).toEqual(["r-a", "sys-5"]);
  });

  it("does not use Math.random() (regression: keys were unstable across renders)", () => {
    // If the impl reintroduced Math.random(), two calls with identical
    // events would produce different keys. Guard with 4 calls.
    const events = [ev({ _seq: 100, msg: "boot" })];
    const runs = Array.from({ length: 4 }, () => groupEvents(events).map((g) => g.key));
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]).toEqual(runs[0]);
    }
  });

  it("falls back to ts+index when _seq is absent (test/synthetic streams)", () => {
    const groups = groupEvents([ev({ ts: 42, msg: "a" }), ev({ ts: 42, msg: "b" })]);
    // Reversed → index-in-original preserved
    expect(groups[0]!.key).toBe("sys-42-1");
    expect(groups[1]!.key).toBe("sys-42-0");
  });

  it("keeps sys keys unique when two system events share the same ts", () => {
    const groups = groupEvents([
      ev({ _seq: 10, ts: 1000 }),
      ev({ _seq: 11, ts: 1000 }),
      ev({ _seq: 12, ts: 1000 }),
    ]);
    const keys = groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns empty on empty input", () => {
    expect(groupEvents([])).toEqual([]);
  });
});
