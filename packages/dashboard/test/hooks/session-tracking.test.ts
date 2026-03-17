import { describe, it, expect } from "vitest";
import {
  dedupEvents,
  extractRequestEnds,
  computeSessionTracker,
  computeConcurrencyTimeline,
} from "@/app/logs/logs-stats";
import type { LogEvent } from "@/hooks/use-log-stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: Date.now() + idCounter++,
    level: "info",
    type: "request_start",
    msg: "test",
    ...overrides,
  };
}

function makeRequestStart(opts: {
  requestId: string;
  sessionId?: string;
  clientName?: string;
  clientVersion?: string;
  accountName?: string;
  ts?: number;
}): LogEvent {
  return makeEvent({
    type: "request_start",
    requestId: opts.requestId,
    ts: opts.ts ?? Date.now() + idCounter++,
    data: {
      sessionId: opts.sessionId ?? "session-1",
      clientName: opts.clientName ?? "Claude Code",
      clientVersion: opts.clientVersion ?? "1.0.0",
      accountName: opts.accountName ?? "default",
      path: "/v1/messages",
      model: "claude-sonnet-4",
    },
  });
}

function makeRequestEnd(opts: {
  requestId: string;
  sessionId?: string;
  clientName?: string;
  clientVersion?: string;
  accountName?: string;
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
  ts?: number;
}): LogEvent {
  return makeEvent({
    type: "request_end",
    requestId: opts.requestId,
    ts: opts.ts ?? Date.now() + idCounter++,
    data: {
      sessionId: opts.sessionId ?? "session-1",
      clientName: opts.clientName ?? "Claude Code",
      clientVersion: opts.clientVersion ?? "1.0.0",
      accountName: opts.accountName ?? "default",
      status: opts.status ?? "success",
      inputTokens: opts.inputTokens ?? 100,
      outputTokens: opts.outputTokens ?? 50,
      latencyMs: 1200,
      model: "claude-sonnet-4",
    },
  });
}

// ===========================================================================
// dedupEvents
// ===========================================================================

describe("dedupEvents", () => {
  it("removes duplicate events with same requestId:type key", () => {
    const e1 = makeEvent({ requestId: "req-1", type: "request_start", ts: 1000 });
    const e2 = makeEvent({ requestId: "req-1", type: "request_start", ts: 1001 }); // duplicate
    const e3 = makeEvent({ requestId: "req-1", type: "request_end", ts: 1002 }); // different type

    const result = dedupEvents([e1, e2, e3]);
    expect(result).toHaveLength(2);
    expect(result[0]!.ts).toBe(1000);
    expect(result[0]!.type).toBe("request_start");
    expect(result[1]!.type).toBe("request_end");
  });

  it("preserves events without requestId (system events)", () => {
    const sys1 = makeEvent({ type: "system" as LogEvent["type"], ts: 100, msg: "sys-1" });
    const sys2 = makeEvent({ type: "system" as LogEvent["type"], ts: 200, msg: "sys-2" });

    const result = dedupEvents([sys1, sys2]);
    expect(result).toHaveLength(2);
  });

  it("sorts output by timestamp", () => {
    const e1 = makeEvent({ requestId: "req-a", type: "request_end", ts: 3000 });
    const e2 = makeEvent({ requestId: "req-b", type: "request_start", ts: 1000 });
    const e3 = makeEvent({ requestId: "req-c", type: "request_start", ts: 2000 });

    const result = dedupEvents([e1, e2, e3]);
    expect(result.map((e) => e.ts)).toEqual([1000, 2000, 3000]);
  });

  it("returns empty array for empty input", () => {
    expect(dedupEvents([])).toEqual([]);
  });

  it("handles ring buffer backfill duplicates", () => {
    const backfill = [
      makeEvent({ requestId: "r1", type: "request_start", ts: 100 }),
      makeEvent({ requestId: "r1", type: "request_end", ts: 200 }),
      makeEvent({ requestId: "r2", type: "request_start", ts: 300 }),
    ];
    const replayed = [
      makeEvent({ requestId: "r1", type: "request_start", ts: 100 }),
      makeEvent({ requestId: "r1", type: "request_end", ts: 200 }),
      makeEvent({ requestId: "r2", type: "request_start", ts: 300 }),
      makeEvent({ requestId: "r3", type: "request_start", ts: 400 }),
    ];

    const result = dedupEvents([...backfill, ...replayed]);
    expect(result).toHaveLength(4);
    expect(result.map((e) => `${e.requestId}:${e.type}`)).toEqual([
      "r1:request_start",
      "r1:request_end",
      "r2:request_start",
      "r3:request_start",
    ]);
  });
});

// ===========================================================================
// computeSessionTracker
// ===========================================================================

describe("computeSessionTracker", () => {
  it("returns empty state for no events", () => {
    const result = computeSessionTracker([]);

    expect(result.sessions).toHaveLength(0);
    expect(result.activeCount).toBe(0);
    expect(result.totalActiveRequests).toBe(0);
  });

  it("creates a session from request_start", () => {
    const events: LogEvent[] = [
      makeRequestStart({
        requestId: "req-1",
        sessionId: "sid-abc",
        clientName: "Claude Code",
        clientVersion: "1.2.3",
      }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.sessionId).toBe("sid-abc");
    expect(result.sessions[0]!.clientName).toBe("Claude Code");
    expect(result.sessions[0]!.clientVersion).toBe("1.2.3");
    expect(result.sessions[0]!.activeRequests.size).toBe(1);
    expect(result.activeCount).toBe(1);
    expect(result.totalActiveRequests).toBe(1);
  });

  it("marks request as inactive after request_end", () => {
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: 1000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: 2000 }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.activeRequests.size).toBe(0);
    expect(result.sessions[0]!.totalRequests).toBe(1);
    expect(result.activeCount).toBe(0);
  });

  it("tracks multiple concurrent sessions", () => {
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: 1000 }),
      makeRequestStart({ requestId: "req-2", sessionId: "sid-2", clientName: "Cursor", ts: 1100 }),
      makeRequestStart({ requestId: "req-3", sessionId: "sid-1", ts: 1200 }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions).toHaveLength(2);
    expect(result.activeCount).toBe(2);
    expect(result.totalActiveRequests).toBe(3);
  });

  it("accumulates tokens from request_end events", () => {
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: 1000 }),
      makeRequestEnd({
        requestId: "req-1",
        sessionId: "sid-1",
        inputTokens: 100,
        outputTokens: 50,
        ts: 2000,
      }),
      makeRequestStart({ requestId: "req-2", sessionId: "sid-1", ts: 3000 }),
      makeRequestEnd({
        requestId: "req-2",
        sessionId: "sid-1",
        inputTokens: 200,
        outputTokens: 100,
        ts: 4000,
      }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions[0]!.totalTokens).toBe(450);
    expect(result.sessions[0]!.totalRequests).toBe(2);
  });

  it("counts errors per session", () => {
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: 1000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", status: "error", ts: 2000 }),
      makeRequestStart({ requestId: "req-2", sessionId: "sid-1", ts: 3000 }),
      makeRequestEnd({ requestId: "req-2", sessionId: "sid-1", status: "success", ts: 4000 }),
      makeRequestStart({ requestId: "req-3", sessionId: "sid-1", ts: 5000 }),
      makeRequestEnd({ requestId: "req-3", sessionId: "sid-1", status: "error", ts: 6000 }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions[0]!.errorCount).toBe(2);
    expect(result.sessions[0]!.totalRequests).toBe(3);
  });

  it("sorts sessions by lastActiveTs descending", () => {
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-old", ts: 1000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-old", ts: 2000 }),
      makeRequestStart({ requestId: "req-2", sessionId: "sid-new", ts: 5000 }),
      makeRequestEnd({ requestId: "req-2", sessionId: "sid-new", ts: 6000 }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions[0]!.sessionId).toBe("sid-new");
    expect(result.sessions[1]!.sessionId).toBe("sid-old");
  });

  it("deduplicates events internally (reconnect replay safe)", () => {
    const start = makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: 1000 });
    const end = makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: 2000 });

    const events: LogEvent[] = [start, end, { ...start }, { ...end }];

    const result = computeSessionTracker(events);

    expect(result.sessions[0]!.totalRequests).toBe(1);
  });

  it("handles request_end without prior request_start (ring buffer eviction)", () => {
    const events: LogEvent[] = [
      makeRequestEnd({
        requestId: "req-orphan",
        sessionId: "sid-1",
        inputTokens: 50,
        outputTokens: 25,
        ts: 5000,
      }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.totalRequests).toBe(1);
    expect(result.sessions[0]!.totalTokens).toBe(75);
    expect(result.sessions[0]!.activeRequests.size).toBe(0);
  });

  it("uses 'unknown' as default sessionId when missing", () => {
    const events: LogEvent[] = [
      makeEvent({
        type: "request_start",
        requestId: "req-no-session",
        ts: 1000,
        data: { clientName: "SomeClient" },
      }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions[0]!.sessionId).toBe("unknown");
  });

  it("correctly tracks activeSessions subset", () => {
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: 1000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: 2000 }),
      makeRequestStart({ requestId: "req-2", sessionId: "sid-1", ts: 3000 }),
      makeRequestStart({ requestId: "req-3", sessionId: "sid-2", ts: 1500 }),
      makeRequestEnd({ requestId: "req-3", sessionId: "sid-2", ts: 2500 }),
    ];

    const result = computeSessionTracker(events);

    expect(result.sessions).toHaveLength(2);
    expect(result.activeSessions).toHaveLength(1);
    expect(result.activeSessions[0]!.sessionId).toBe("sid-1");
    expect(result.activeCount).toBe(1);
    expect(result.totalActiveRequests).toBe(1);
  });
});

// ===========================================================================
// computeConcurrencyTimeline
// ===========================================================================

describe("computeConcurrencyTimeline", () => {
  it("returns empty for no events", () => {
    const result = computeConcurrencyTimeline([]);
    expect(result).toHaveLength(0);
  });

  it("returns one bucket for a single request within one minute", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: base + 1000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: base + 5000 }),
    ];

    const result = computeConcurrencyTimeline(events);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const bucket = result.find((b) => b.minute === base);
    expect(bucket).toBeDefined();
    expect(bucket!.sessions).toBe(1);
  });

  it("counts distinct sessions per minute bucket", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: base + 1000 }),
      makeRequestStart({ requestId: "req-2", sessionId: "sid-2", ts: base + 2000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: base + 30000 }),
      makeRequestEnd({ requestId: "req-2", sessionId: "sid-2", ts: base + 40000 }),
    ];

    const result = computeConcurrencyTimeline(events);

    const bucket = result.find((b) => b.minute === base);
    expect(bucket).toBeDefined();
    expect(bucket!.sessions).toBe(2);
  });

  it("spans multiple minute buckets for long-running requests", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: base + 1000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: base + 130_000 }),
    ];

    const result = computeConcurrencyTimeline(events);

    expect(result.length).toBeGreaterThanOrEqual(3);
    const buckets = result.filter(
      (b) => b.minute >= base && b.minute <= base + 120_000,
    );
    expect(buckets).toHaveLength(3);
    for (const b of buckets) {
      expect(b.sessions).toBe(1);
    }
  });

  it("in-progress requests use current time as effective end", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: base + 1000 }),
    ];

    const result = computeConcurrencyTimeline(events);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const bucket = result.find((b) => b.minute === base);
    expect(bucket).toBeDefined();
    expect(bucket!.sessions).toBe(1);
  });

  it("limits output to last 30 buckets", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const startTs = base - 60 * 60_000;
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: startTs }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: base + 1000 }),
    ];

    const result = computeConcurrencyTimeline(events);

    expect(result.length).toBeLessThanOrEqual(30);
  });

  it("sorts buckets by minute ascending", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: base + 1000 }),
      makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: base + 130_000 }),
    ];

    const result = computeConcurrencyTimeline(events);

    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.minute).toBeGreaterThan(result[i - 1]!.minute);
    }
  });

  it("deduplicates events internally", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const start = makeRequestStart({ requestId: "req-1", sessionId: "sid-1", ts: base + 1000 });
    const end = makeRequestEnd({ requestId: "req-1", sessionId: "sid-1", ts: base + 5000 });

    const events: LogEvent[] = [start, end, { ...start }, { ...end }];

    const result = computeConcurrencyTimeline(events);

    const bucket = result.find((b) => b.minute === base);
    expect(bucket).toBeDefined();
    expect(bucket!.sessions).toBe(1);
  });
});

// ===========================================================================
// extractRequestEnds (dedup on reconnect replay)
// ===========================================================================

describe("extractRequestEnds", () => {
  it("extracts request_end events", () => {
    const events: LogEvent[] = [
      makeRequestStart({ requestId: "req-1", ts: 1000 }),
      makeRequestEnd({ requestId: "req-1", ts: 2000, inputTokens: 100, outputTokens: 50 }),
    ];

    const result = extractRequestEnds(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.inputTokens).toBe(100);
    expect(result[0]!.outputTokens).toBe(50);
  });

  it("deduplicates request_end by requestId on reconnect replay", () => {
    const end1 = makeRequestEnd({ requestId: "req-1", ts: 2000, inputTokens: 100, outputTokens: 50 });
    const end2 = makeRequestEnd({ requestId: "req-2", ts: 3000, inputTokens: 200, outputTokens: 100 });

    // Simulate reconnect replay: same events appended again
    const events: LogEvent[] = [end1, end2, { ...end1 }, { ...end2 }];

    const result = extractRequestEnds(events);
    expect(result).toHaveLength(2); // Not 4
  });

  it("counts are correct after dedup", () => {
    const end = makeRequestEnd({ requestId: "req-1", ts: 2000, inputTokens: 100, outputTokens: 50 });

    // 3 copies of the same request_end
    const events: LogEvent[] = [end, { ...end }, { ...end }];

    const result = extractRequestEnds(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.inputTokens).toBe(100);
  });

  it("preserves events without requestId", () => {
    const events: LogEvent[] = [
      makeEvent({
        type: "request_end",
        ts: 1000,
        data: { model: "test", inputTokens: 10, outputTokens: 5, latencyMs: 100, status: "success" },
      }),
      makeEvent({
        type: "request_end",
        ts: 2000,
        data: { model: "test", inputTokens: 20, outputTokens: 10, latencyMs: 200, status: "success" },
      }),
    ];

    const result = extractRequestEnds(events);
    expect(result).toHaveLength(2);
  });

  it("skips events without data", () => {
    const events: LogEvent[] = [
      makeEvent({ type: "request_end", requestId: "req-1", ts: 1000 }),
    ];

    const result = extractRequestEnds(events);
    expect(result).toHaveLength(0);
  });
});
