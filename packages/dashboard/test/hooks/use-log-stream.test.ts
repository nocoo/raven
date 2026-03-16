// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

type ESListener = (e: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0; // CONNECTING
  close = vi.fn(() => {
    this.readyState = 2; // CLOSED
  });

  private listeners: Record<string, ESListener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: ESListener) {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: ESListener) {
    const arr = this.listeners[type];
    if (arr) {
      this.listeners[type] = arr.filter((h) => h !== handler);
    }
  }

  // Test helper: emit an event to registered listeners
  emit(type: string, data?: string) {
    for (const h of this.listeners[type] ?? []) {
      h(new MessageEvent(type, { data }));
    }
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Lazy import to pick up the mocked EventSource
async function importHook() {
  const mod = await import("@/hooks/use-log-stream");
  return mod.useLogStream;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastES(): MockEventSource {
  const es = MockEventSource.instances[MockEventSource.instances.length - 1];
  if (!es) throw new Error("No MockEventSource instance found");
  return es;
}

function makeLogData(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ts: Date.now(),
    level: "info",
    type: "request_start",
    msg: "test message",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLogStream", () => {
  describe("connection", () => {
    it("creates EventSource with correct URL params", async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream());

      const es = lastES();
      expect(es.url).toBe("/api/logs/stream?level=info");
    });

    it("includes level param", async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream({ level: "debug" }));

      const es = lastES();
      const url = new URL(es.url, "http://localhost");
      expect(url.searchParams.get("level")).toBe("debug");
    });

    it("includes requestId param when provided", async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream({ requestId: "req-abc" }));

      const es = lastES();
      const url = new URL(es.url, "http://localhost");
      expect(url.searchParams.get("requestId")).toBe("req-abc");
    });

    it("enabled=false → no EventSource created", async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream({ enabled: false }));

      expect(MockEventSource.instances).toHaveLength(0);
    });
  });

  describe("events", () => {
    it('"connected" event → sets connected=true', async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      expect(result.current.connected).toBe(false);

      act(() => {
        lastES().emit("connected");
      });

      expect(result.current.connected).toBe(true);
    });

    it('"connected" event → resets reconnect counter', async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      // Trigger disconnected to increment reconnect attempt
      act(() => {
        lastES().emit("disconnected");
      });

      // Advance timer to trigger reconnect
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // Now a new EventSource is created; emit connected on it
      act(() => {
        lastES().emit("connected");
      });

      expect(result.current.connected).toBe(true);

      // Disconnect again — if counter was reset, delay should be 1s (attempt 0)
      act(() => {
        lastES().emit("disconnected");
      });

      // Advance 1s should trigger reconnect (base delay for attempt 0)
      const countBefore = MockEventSource.instances.length;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances.length).toBe(countBefore + 1);
    });

    it('"log" event → appends to events array', async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      act(() => {
        lastES().emit("log", makeLogData({ msg: "hello" }));
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0]!.msg).toBe("hello");
    });

    it('"log" event with malformed JSON → ignored (no crash)', async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      act(() => {
        lastES().emit("log", "not-json{{{");
      });

      expect(result.current.events).toHaveLength(0);
    });

    it("events capped at maxEvents", async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream({ maxEvents: 3 }));

      act(() => {
        for (let i = 0; i < 5; i++) {
          lastES().emit("log", makeLogData({ msg: `msg-${i}` }));
        }
      });

      expect(result.current.events).toHaveLength(3);
      // Keeps most recent
      expect(result.current.events[0]!.msg).toBe("msg-2");
      expect(result.current.events[2]!.msg).toBe("msg-4");
    });
  });

  describe("pause/resume", () => {
    it("setPaused(true) → buffers incoming events", async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      // Pause
      act(() => {
        result.current.setPaused(true);
      });

      // Send events while paused
      act(() => {
        lastES().emit("log", makeLogData({ msg: "buffered-1" }));
        lastES().emit("log", makeLogData({ msg: "buffered-2" }));
      });

      // Events should NOT appear in the array while paused
      expect(result.current.events).toHaveLength(0);
    });

    it("setPaused(false) → flushes buffer into events", async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      // Pause, send events, unpause
      act(() => {
        result.current.setPaused(true);
      });

      act(() => {
        lastES().emit("log", makeLogData({ msg: "buffered" }));
      });

      act(() => {
        result.current.setPaused(false);
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0]!.msg).toBe("buffered");
    });

    it("buffer flush respects maxEvents cap", async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream({ maxEvents: 2 }));

      // Add one event before pausing
      act(() => {
        lastES().emit("log", makeLogData({ msg: "pre" }));
      });

      act(() => {
        result.current.setPaused(true);
      });

      // Buffer 3 events while paused
      act(() => {
        lastES().emit("log", makeLogData({ msg: "buf-1" }));
        lastES().emit("log", makeLogData({ msg: "buf-2" }));
        lastES().emit("log", makeLogData({ msg: "buf-3" }));
      });

      act(() => {
        result.current.setPaused(false);
      });

      // maxEvents = 2, should keep only the last 2
      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[0]!.msg).toBe("buf-2");
      expect(result.current.events[1]!.msg).toBe("buf-3");
    });
  });

  describe("reconnect", () => {
    it('"disconnected" event → closes EventSource + schedules reconnect', async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream());

      const es = lastES();
      act(() => {
        es.emit("disconnected");
      });

      expect(es.close).toHaveBeenCalled();

      // Advance past reconnect delay (1s for attempt 0)
      const countBefore = MockEventSource.instances.length;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances.length).toBe(countBefore + 1);
    });

    it('"error" event → closes EventSource + schedules reconnect', async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream());

      const es = lastES();
      act(() => {
        es.emit("error");
      });

      expect(es.close).toHaveBeenCalled();

      const countBefore = MockEventSource.instances.length;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances.length).toBe(countBefore + 1);
    });

    it("reconnect uses exponential backoff (1s, 2s, 4s, ..., 30s max)", async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream());

      // Attempt 0 → 1s
      act(() => {
        lastES().emit("disconnected");
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // Attempt 1 → 2s
      act(() => {
        lastES().emit("disconnected");
      });
      const countAfter1 = MockEventSource.instances.length;
      act(() => {
        vi.advanceTimersByTime(1999);
      });
      // Not yet
      expect(MockEventSource.instances.length).toBe(countAfter1);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      // Now
      expect(MockEventSource.instances.length).toBe(countAfter1 + 1);

      // Attempt 2 → 4s
      act(() => {
        lastES().emit("disconnected");
      });
      const countAfter2 = MockEventSource.instances.length;
      act(() => {
        vi.advanceTimersByTime(3999);
      });
      expect(MockEventSource.instances.length).toBe(countAfter2);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(MockEventSource.instances.length).toBe(countAfter2 + 1);
    });

    it("duplicate reconnect guard (disconnected + error → only one reconnect)", async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream());

      const es = lastES();
      // Both events fire on same EventSource
      act(() => {
        es.emit("disconnected");
        es.emit("error");
      });

      const countBefore = MockEventSource.instances.length;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // Only one new EventSource despite both events
      expect(MockEventSource.instances.length).toBe(countBefore + 1);
    });

    it("successful reconnect resets attempt counter", async () => {
      const useLogStream = await importHook();
      renderHook(() => useLogStream());

      // Disconnect 3 times (attempt 0, 1, 2)
      for (let i = 0; i < 3; i++) {
        act(() => {
          lastES().emit("disconnected");
        });
        act(() => {
          vi.advanceTimersByTime(30000); // Advance enough for any backoff
        });
      }

      // Now reconnect and emit "connected" → resets counter
      act(() => {
        lastES().emit("connected");
      });

      // Disconnect again → should use attempt 0 delay (1s)
      act(() => {
        lastES().emit("disconnected");
      });
      const countBefore = MockEventSource.instances.length;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances.length).toBe(countBefore + 1);
    });
  });

  describe("cleanup", () => {
    it("unmount → closes EventSource", async () => {
      const useLogStream = await importHook();
      const { unmount } = renderHook(() => useLogStream());

      const es = lastES();
      unmount();

      expect(es.close).toHaveBeenCalled();
    });

    it("unmount → clears reconnect timer", async () => {
      const useLogStream = await importHook();
      const { unmount } = renderHook(() => useLogStream());

      // Schedule a reconnect
      act(() => {
        lastES().emit("disconnected");
      });

      const countBefore = MockEventSource.instances.length;
      unmount();

      // Advance past reconnect delay — should NOT create new EventSource
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(MockEventSource.instances.length).toBe(countBefore);
    });

    it("level change → reconnects with new URL", async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      const firstES = lastES();

      act(() => {
        result.current.setLevel("debug");
      });

      // A new EventSource should be created with the new level
      const newES = lastES();
      expect(newES).not.toBe(firstES);
      const url = new URL(newES.url, "http://localhost");
      expect(url.searchParams.get("level")).toBe("debug");
      // Old one should have been closed
      expect(firstES.close).toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("clear() → empties events array", async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      act(() => {
        lastES().emit("log", makeLogData({ msg: "event-1" }));
        lastES().emit("log", makeLogData({ msg: "event-2" }));
      });
      expect(result.current.events).toHaveLength(2);

      act(() => {
        result.current.clear();
      });
      expect(result.current.events).toHaveLength(0);
    });

    it("clear() → empties pause buffer", async () => {
      const useLogStream = await importHook();
      const { result } = renderHook(() => useLogStream());

      // Pause and buffer events
      act(() => {
        result.current.setPaused(true);
      });
      act(() => {
        lastES().emit("log", makeLogData({ msg: "buffered" }));
      });

      // Clear while paused
      act(() => {
        result.current.clear();
      });

      // Unpause — buffer was cleared, so nothing flushes
      act(() => {
        result.current.setPaused(false);
      });
      expect(result.current.events).toHaveLength(0);
    });
  });
});
