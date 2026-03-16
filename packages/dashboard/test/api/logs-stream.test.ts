import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Controllable MockWebSocket
// ---------------------------------------------------------------------------

type WSCallback = ((...args: unknown[]) => void) | null;

class MockWebSocket {
  static CLOSED = 3;
  onopen: WSCallback = null;
  onmessage: WSCallback = null;
  onerror: WSCallback = null;
  onclose: WSCallback = null;
  readyState = 0;
  url: string;
  closeCalled = false;

  constructor(url: string) {
    MockWebSocket.lastInstance = this;
    this.url = url;
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.closeCalled = true;
  }

  // Test helper: access last created instance
  static lastInstance: MockWebSocket | null = null;

  // Test helper: should constructor throw?
  static shouldThrow = false;
}

// Factory that optionally throws
function createMockWSFactory() {
  return class extends MockWebSocket {
    constructor(url: string) {
      if (MockWebSocket.shouldThrow) {
        throw new Error("WebSocket constructor failed");
      }
      super(url);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSSEEvents(response: Response, maxEvents = 10): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];

  for (let i = 0; i < maxEvents; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(decoder.decode(value));
  }

  reader.releaseLock();
  return events;
}

function parseSSEEvent(raw: string): { event: string; data: unknown } | null {
  const eventMatch = raw.match(/event: (\w+)/);
  const dataMatch = raw.match(/data: (.+)/);
  if (!eventMatch || !dataMatch) return null;
  const event = eventMatch[1]!;
  const data = dataMatch[1]!;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/logs/stream", () => {
  let WSFactory: ReturnType<typeof createMockWSFactory>;

  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.lastInstance = null;
    MockWebSocket.shouldThrow = false;
    WSFactory = createMockWSFactory();
    vi.stubGlobal("WebSocket", WSFactory);
    vi.stubEnv("RAVEN_PROXY_URL", "http://localhost:7033");
    vi.stubEnv("RAVEN_API_KEY", "test-api-key");
    // Ensure RAVEN_INTERNAL_KEY is undefined so ?? falls through to RAVEN_API_KEY
    delete process.env.RAVEN_INTERNAL_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function importAndCall(url: string) {
    const { GET } = await import("@/app/api/logs/stream/route");
    const req = new NextRequest(new URL(url, "http://localhost"));
    return GET(req);
  }

  describe("connection setup", () => {
    it("builds WebSocket URL with ws:// protocol from http://", async () => {
      await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      expect(ws.url).toMatch(/^ws:\/\/localhost:7033\/ws\/logs\?/);
      // Consume stream to avoid dangling
      ws.onclose?.();
    });

    it("builds WebSocket URL with wss:// protocol from https://", async () => {
      vi.stubEnv("RAVEN_PROXY_URL", "https://proxy.example.com");
      await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      expect(ws.url).toMatch(/^wss:\/\/proxy\.example\.com\/ws\/logs\?/);
      ws.onclose?.();
    });

    it("includes API_KEY as token query param", async () => {
      await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      const url = new URL(ws.url);
      expect(url.searchParams.get("token")).toBe("test-api-key");
      ws.onclose?.();
    });

    it("includes level query param (default: info)", async () => {
      await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      const url = new URL(ws.url);
      expect(url.searchParams.get("level")).toBe("info");
      ws.onclose?.();
    });

    it("includes custom level query param", async () => {
      await importAndCall("http://localhost/api/logs/stream?level=debug");
      const ws = MockWebSocket.lastInstance!;

      const url = new URL(ws.url);
      expect(url.searchParams.get("level")).toBe("debug");
      ws.onclose?.();
    });

    it("includes requestId query param when provided", async () => {
      await importAndCall("http://localhost/api/logs/stream?requestId=req-123");
      const ws = MockWebSocket.lastInstance!;

      const url = new URL(ws.url);
      expect(url.searchParams.get("requestId")).toBe("req-123");
      ws.onclose?.();
    });

    it("returns response with Content-Type: text/event-stream", async () => {
      const res = await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
      ws.onclose?.();
    });
  });

  describe("SSE events", () => {
    it("onopen → emits connected SSE event", async () => {
      const res = await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      // Trigger onopen
      ws.onopen?.();
      // Then close to end stream
      ws.onclose?.();

      const events = await readSSEEvents(res);
      const parsed = events.map(parseSSEEvent).filter(Boolean);
      expect(parsed[0]).toEqual({ event: "connected", data: { status: "connected" } });
    });

    it("onmessage → emits log SSE event with message data", async () => {
      const res = await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      ws.onopen?.();
      const logData = JSON.stringify({ ts: 1234, level: "info", msg: "test" });
      ws.onmessage?.({ data: logData });
      ws.onclose?.();

      const events = await readSSEEvents(res);
      const logEvent = events.find((e) => e.includes("event: log"));
      expect(logEvent).toBeDefined();
      expect(logEvent).toContain(logData);
    });

    it("onerror → emits error SSE event", async () => {
      const res = await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      ws.onerror?.();
      ws.onclose?.();

      const events = await readSSEEvents(res);
      const errorEvent = events.find((e) => e.includes("event: error"));
      expect(errorEvent).toBeDefined();
      expect(errorEvent).toContain("Upstream connection error");
    });

    it("onclose → emits disconnected SSE event + closes stream", async () => {
      const res = await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;

      ws.onclose?.();

      const events = await readSSEEvents(res);
      const disconnected = events.find((e) => e.includes("event: disconnected"));
      expect(disconnected).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("WebSocket constructor throws → emits error event + closes stream", async () => {
      MockWebSocket.shouldThrow = true;

      const res = await importAndCall("http://localhost/api/logs/stream");
      const events = await readSSEEvents(res);

      expect(events.length).toBeGreaterThan(0);
      const errorEvent = events.find((e) => e.includes("event: error"));
      expect(errorEvent).toBeDefined();
      expect(errorEvent).toContain("Failed to connect to proxy");
    });
  });

  describe("cleanup", () => {
    it("stream cancel → closes upstream WebSocket", async () => {
      const res = await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;
      ws.readyState = 1; // OPEN

      // Cancel the stream (simulates browser disconnect)
      await res.body!.cancel();

      expect(ws.closeCalled).toBe(true);
    });

    it("stream cancel when WS already closed → no error", async () => {
      const res = await importAndCall("http://localhost/api/logs/stream");
      const ws = MockWebSocket.lastInstance!;
      ws.readyState = MockWebSocket.CLOSED;

      // Should not throw
      await res.body!.cancel();
      expect(ws.closeCalled).toBe(false);
    });
  });
});
