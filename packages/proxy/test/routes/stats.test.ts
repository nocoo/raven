import { describe, expect, test, beforeEach, afterEach } from "vitest";
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

describe("GET /api/stats/summary", () => {
  test("returns comprehensive stats", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/summary");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total_requests).toBe(4);
    expect(body.total_tokens).toBe(345);
    expect(body.total_input_tokens).toBe(230); // 50+100+80+0
    expect(body.total_output_tokens).toBe(115); // 25+50+40+0
    expect(body.error_count).toBe(1);
    expect(body.error_rate).toBeCloseTo(0.25);
    expect(typeof body.avg_latency_ms).toBe("number");
    expect(body.stream_count).toBe(0);
    expect(body.sync_count).toBe(4);
  });

  test("respects filter params", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/summary?model=gpt-4o");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total_requests).toBe(2);
    expect(body.error_count).toBe(1);
    expect(body.error_rate).toBeCloseTo(0.5);
  });
});

describe("GET /api/stats/breakdown", () => {
  test("returns breakdown by model", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown?by=model");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0]).toHaveProperty("key");
    expect(body[0]).toHaveProperty("count");
    expect(body[0]).toHaveProperty("error_rate");
    expect(body[0]).toHaveProperty("p95_latency_ms");
    expect(body[0]).toHaveProperty("first_seen");
    expect(body[0]).toHaveProperty("last_seen");
  });

  test("missing by param → 400", async () => {
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown");
    expect(res.status).toBe(400);
  });

  test("respects sort and order", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown?by=model&sort=count&order=asc");
    const body = await res.json();
    expect(body[0].count).toBeLessThanOrEqual(body[1].count);
  });

  test("respects limit", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown?by=model&limit=1");
    const body = await res.json();
    expect(body.length).toBe(1);
  });

  test("supports filter params", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown?by=status&model=gpt-4o");
    const body = await res.json();
    // gpt-4o has 2 records (1 success, 1 error)
    expect(body.length).toBe(2);
  });
});

describe("GET /api/stats/percentiles", () => {
  test("returns percentile distribution", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/percentiles?metric=latency_ms");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("p50");
    expect(body).toHaveProperty("p95");
    expect(body).toHaveProperty("p99");
    expect(body).toHaveProperty("min");
    expect(body).toHaveProperty("max");
    expect(body.count).toBe(4);
  });

  test("missing metric → 400", async () => {
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/percentiles");
    expect(res.status).toBe(400);
  });

  test("unsupported metric → 400", async () => {
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/percentiles?metric=nonexistent");
    expect(res.status).toBe(400);
  });

  test("respects model filter", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/percentiles?metric=latency_ms&model=gpt-4o");
    const body = await res.json();
    expect(body.count).toBe(2);
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

// ===========================================================================
// Regression: sort=error_rate on /stats/breakdown must not 500
// ===========================================================================

describe("breakdown sort=error_rate", () => {
  test("returns 200 and correctly sorted results", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown?by=model&sort=error_rate&order=desc");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ key: string; error_rate: number }>;
    expect(body.length).toBeGreaterThan(0);
    // gpt-4o has 50% error rate (1/2 is error), should be first when sorting by error_rate desc
    expect(body[0]!.key).toBe("gpt-4o");
    expect(body[0]!.error_rate).toBeCloseTo(0.5);
  });

  test("sort=p95_latency_ms returns 200 with JS-sorted results", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown?by=model&sort=p95_latency_ms&order=desc");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ key: string; p95_latency_ms: number }>;
    expect(body.length).toBeGreaterThan(0);
    // p95 should be defined for all entries
    for (const entry of body) {
      expect(entry.p95_latency_ms).toBeGreaterThanOrEqual(0);
    }
    // Should be sorted descending
    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1]!.p95_latency_ms).toBeGreaterThanOrEqual(body[i]!.p95_latency_ms);
    }
  });

  test("sort=avg_ttft_ms returns 200", async () => {
    seedDb(db);
    const app = new Hono();
    app.route("/api", createStatsRoute(db));

    const res = await app.request("/api/stats/breakdown?by=model&sort=avg_ttft_ms&order=desc");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ key: string }>;
    expect(body.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Regression: timeseries with explicit from/to should not be clamped to 24h
// ===========================================================================

describe("timeseries explicit from/to range", () => {
  test("returns data older than 24h when from/to span multiple days", async () => {
    const db2 = createTestDb();
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60_000;

    // Insert a request 2 days ago
    insertRequest(db2, makeRecord({
      timestamp: twoDaysAgo,
      model: "old-model",
      latency_ms: 500,
    }));
    // And one now
    insertRequest(db2, makeRecord({
      timestamp: now - 1000,
      model: "new-model",
      latency_ms: 200,
    }));

    const app = new Hono();
    app.route("/api", createStatsRoute(db2));

    // Request 3 days of data
    const from = now - 3 * 24 * 60 * 60_000;
    const to = now;
    const res = await app.request(`/api/stats/timeseries?interval=day&from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ bucket: number; count: number }>;

    // Should find both records (spanning multiple day buckets)
    const totalCount = body.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBe(2);

    db2.close();
  });

  test("timeseries with range= param but no from/to still applies default window", async () => {
    const db2 = createTestDb();
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60_000;

    // Insert a request 2 days ago (outside 1h window)
    insertRequest(db2, makeRecord({
      timestamp: twoDaysAgo,
      model: "old-model",
    }));
    // And one 30 minutes ago (inside 1h window)
    insertRequest(db2, makeRecord({
      timestamp: now - 30 * 60_000,
      model: "new-model",
    }));

    const app = new Hono();
    app.route("/api", createStatsRoute(db2));

    // Request only last 1h
    const res = await app.request("/api/stats/timeseries?interval=minute&range=1h");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ bucket: number; count: number }>;

    // Should only find the recent record
    const totalCount = body.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBe(1);

    db2.close();
  });
});
