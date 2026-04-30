import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createStatsRoute } from "../../src/routes/stats.ts";
import { createRequestsRoute } from "../../src/routes/requests.ts";
import {
  initDatabase,
  insertRequest,
  type RequestRecord,
} from "../../src/db/requests.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  initDatabase(db);
  return db;
}

function makeRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: `01J${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    timestamp: Date.now(),
    path: "/v1/messages",
    client_format: "anthropic",
    model: "claude-sonnet-4",
    resolved_model: "claude-sonnet-4",
    stream: 0,
    input_tokens: 100,
    output_tokens: 50,
    latency_ms: 1200,
    ttft_ms: null,
    status: "success",
    status_code: 200,
    upstream_status: 200,
    error_message: null,
    account_name: "default",
    session_id: "",
    client_name: "",
    client_version: null,
    processing_ms: null,
    strategy: "",
    upstream: "",
    upstream_format: "",
    translated_model: "",
    copilot_model: "",
    routing_path: "",
    stop_reason: "",
    tool_call_count: 0,
    ...overrides,
  };
}

function seedDb(db: Database): void {
  insertRequest(db, makeRecord({ model: "claude-sonnet-4", latency_ms: 100, input_tokens: 50, output_tokens: 25 }));
  insertRequest(db, makeRecord({ model: "claude-sonnet-4", latency_ms: 200, input_tokens: 100, output_tokens: 50 }));
  insertRequest(db, makeRecord({ model: "gpt-4o", latency_ms: 150, input_tokens: 80, output_tokens: 40 }));
  insertRequest(db, makeRecord({ model: "gpt-4o", status: "error", status_code: 429, latency_ms: 50, input_tokens: 0, output_tokens: 0 }));
}

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// Stats routes
// ===========================================================================

describe("GET /api/stats/overview", () => {
  test("returns aggregate stats", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/overview");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total_requests).toBe(4);
    expect(body.total_tokens).toBe(345); // 75 + 150 + 120 + 0
    expect(body.error_count).toBe(1);
    expect(typeof body.avg_latency_ms).toBe("number");
  });
});

describe("GET /api/stats/timeseries", () => {
  test("returns time buckets", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/timeseries?interval=hour&range=24h");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("bucket");
    expect(body[0]).toHaveProperty("count");
  });

  test("uses defaults for missing params", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/timeseries");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/stats/models", () => {
  test("returns per-model stats", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/models");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2); // claude-sonnet-4 and gpt-4o
  });
});

describe("GET /api/stats/recent", () => {
  test("returns recent records with limit", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/recent?limit=2");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });

  test("returns recent records without limit (default)", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/recent");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(4); // all seeded records
  });
});

// ===========================================================================
// Requests route
// ===========================================================================

describe("GET /api/requests", () => {
  test("returns paginated results", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(4);
    expect(typeof body.has_more).toBe("boolean");
  });

  test("filters by model", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?model=gpt-4o");
    const body = await res.json();
    expect(body.data.length).toBe(2);
    expect(body.data.every((r: { model: string }) => r.model === "gpt-4o")).toBe(true);
  });

  test("filters by status", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?status=error");
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].status).toBe("error");
  });

  test("sorts by latency_ms", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?sort=latency_ms&order=desc");
    const body = await res.json();
    expect(body.data[0].latency_ms).toBeGreaterThanOrEqual(body.data[1].latency_ms);
    // Offset pagination returns total
    expect(body.total).toBe(4);
  });

  test("cursor pagination", async () => {
    // Insert enough records for pagination
    for (let i = 0; i < 10; i++) {
      insertRequest(db, makeRecord({ timestamp: 1000 + i }));
    }

    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res1 = await app.request("/api/requests?limit=3&sort=timestamp&order=desc");
    const body1 = await res1.json();
    expect(body1.data.length).toBe(3);
    expect(body1.has_more).toBe(true);
    expect(body1.next_cursor).toBeDefined();

    const res2 = await app.request(`/api/requests?limit=3&sort=timestamp&order=desc&cursor=${body1.next_cursor}`);
    const body2 = await res2.json();
    expect(body2.data.length).toBe(3);
    // No overlap
    const ids1 = body1.data.map((r: { id: string }) => r.id);
    expect(body2.data.every((r: { id: string }) => !ids1.includes(r.id))).toBe(true);
  });

  test("invalid limit → 400", async () => {
    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?limit=foo");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("number");
  });

  test("invalid offset → 400", async () => {
    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?offset=bar");
    expect(res.status).toBe(400);
  });

  test("filters by analytics params (from/to)", async () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ model: "a", timestamp: now - 5000 }));
    insertRequest(db, makeRecord({ model: "b", timestamp: now - 1000 }));
    insertRequest(db, makeRecord({ model: "c", timestamp: now + 5000 }));

    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request(`/api/requests?from=${now - 3000}&to=${now}`);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].model).toBe("b");
  });

  test("filters by strategy", async () => {
    insertRequest(db, makeRecord({ strategy: "copilot-native" }));
    insertRequest(db, makeRecord({ strategy: "custom-openai" }));
    insertRequest(db, makeRecord({ strategy: "copilot-native" }));

    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?strategy=custom-openai");
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].strategy).toBe("custom-openai");
  });

  test("sorts by new columns (ttft_ms)", async () => {
    insertRequest(db, makeRecord({ ttft_ms: 100 }));
    insertRequest(db, makeRecord({ ttft_ms: 500 }));
    insertRequest(db, makeRecord({ ttft_ms: 200 }));

    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?sort=ttft_ms&order=desc");
    const body = await res.json();
    expect(body.data[0].ttft_ms).toBe(500);
    expect(body.data[2].ttft_ms).toBe(100);
  });

  test("filters by has_error", async () => {
    insertRequest(db, makeRecord({ status: "success" }));
    insertRequest(db, makeRecord({ status: "error" }));
    insertRequest(db, makeRecord({ status: "success" }));

    const app = new Hono();
    app.route("/api", createRequestsRoute(db));

    const res = await app.request("/api/requests?has_error=true");
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].status).toBe("error");
  });
});

// ===========================================================================
// Stats route param validation
// ===========================================================================

describe("stats param validation", () => {
  test("invalid limit on /api/stats/recent → 400", async () => {
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/recent?limit=abc");
    expect(res.status).toBe(400);
  });
});
