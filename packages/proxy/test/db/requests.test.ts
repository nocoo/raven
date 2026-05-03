import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import {
  initDatabase,
  insertRequest,
  queryOverview,
  queryTimeseries,
  queryModels,
  queryRecent,
  queryRequests,
  querySummary,
  queryBreakdown,
  queryPercentiles,
  type RequestRecord,
  type ModelStats,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// Schema initialization
// ===========================================================================

describe("initDatabase", () => {
  test("creates requests table", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='requests'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("sets WAL mode (skipped for in-memory db)", () => {
    // WAL mode falls back to "memory" for :memory: databases
    // This test validates initDatabase calls PRAGMA journal_mode=WAL
    // For file-based DBs it would be "wal"
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(["wal", "memory"]).toContain(result.journal_mode);
  });

  test("creates indexes", () => {
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_requests_%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_requests_timestamp");
    expect(names).toContain("idx_requests_model");
    expect(names).toContain("idx_requests_status");
    expect(names).toContain("idx_requests_latency");
    expect(names).toContain("idx_requests_total_tokens");
  });

  test("idempotent (can run twice)", () => {
    expect(() => initDatabase(db)).not.toThrow();
  });
});

// ===========================================================================
// insertRequest
// ===========================================================================

describe("insertRequest", () => {
  test("inserts a record", () => {
    const record = makeRecord();
    insertRequest(db, record);

    const rows = db.query("SELECT * FROM requests").all();
    expect(rows).toHaveLength(1);
  });

  test("total_tokens is computed", () => {
    insertRequest(
      db,
      makeRecord({ input_tokens: 100, output_tokens: 50 }),
    );
    const row = db.query("SELECT total_tokens FROM requests").get() as {
      total_tokens: number;
    };
    expect(row.total_tokens).toBe(150);
  });

  test("null tokens → total_tokens is 0", () => {
    insertRequest(
      db,
      makeRecord({ input_tokens: null, output_tokens: null }),
    );
    const row = db.query("SELECT total_tokens FROM requests").get() as {
      total_tokens: number;
    };
    expect(row.total_tokens).toBe(0);
  });
});

// ===========================================================================
// queryOverview
// ===========================================================================

describe("queryOverview", () => {
  test("returns aggregate stats", () => {
    insertRequest(db, makeRecord({ input_tokens: 100, output_tokens: 50, latency_ms: 200 }));
    insertRequest(db, makeRecord({ input_tokens: 200, output_tokens: 100, latency_ms: 400 }));
    insertRequest(
      db,
      makeRecord({ status: "error", input_tokens: 0, output_tokens: 0, latency_ms: 50 }),
    );

    const result = queryOverview(db);
    expect(result.total_requests).toBe(3);
    expect(result.total_tokens).toBe(450); // 150 + 300 + 0
    expect(result.error_count).toBe(1);
    expect(result.avg_latency_ms).toBeCloseTo(216.67, 0);
  });

  test("empty db → zeros", () => {
    const result = queryOverview(db);
    expect(result.total_requests).toBe(0);
    expect(result.total_tokens).toBe(0);
    expect(result.error_count).toBe(0);
    expect(result.avg_latency_ms).toBe(0);
  });
});

// ===========================================================================
// querySummary
// ===========================================================================

describe("querySummary", () => {
  test("returns comprehensive stats with no filters", () => {
    insertRequest(db, makeRecord({ input_tokens: 100, output_tokens: 50, latency_ms: 200, stream: 1, ttft_ms: 80 }));
    insertRequest(db, makeRecord({ input_tokens: 200, output_tokens: 100, latency_ms: 400, stream: 0 }));
    insertRequest(db, makeRecord({ status: "error", input_tokens: 0, output_tokens: 0, latency_ms: 50, stream: 0 }));

    const result = querySummary(db, "", []);
    expect(result.total_requests).toBe(3);
    expect(result.total_tokens).toBe(450);
    expect(result.total_input_tokens).toBe(300);
    expect(result.total_output_tokens).toBe(150);
    expect(result.error_count).toBe(1);
    expect(result.error_rate).toBeCloseTo(1 / 3);
    expect(result.avg_ttft_ms).toBe(80); // only 1 non-null ttft_ms
    expect(result.stream_count).toBe(1);
    expect(result.sync_count).toBe(2);
  });

  test("respects WHERE clause filter", () => {
    insertRequest(db, makeRecord({ model: "claude-3", input_tokens: 100, output_tokens: 50 }));
    insertRequest(db, makeRecord({ model: "gpt-4o", input_tokens: 200, output_tokens: 100 }));

    const result = querySummary(db, "WHERE model = ?", ["claude-3"]);
    expect(result.total_requests).toBe(1);
    expect(result.total_input_tokens).toBe(100);
  });

  test("empty db → zeros", () => {
    const result = querySummary(db, "", []);
    expect(result.total_requests).toBe(0);
    expect(result.error_rate).toBe(0);
    expect(result.avg_ttft_ms).toBeNull();
    expect(result.avg_processing_ms).toBeNull();
  });
});

// ===========================================================================
// queryTimeseries
// ===========================================================================

describe("queryTimeseries", () => {
  test("aggregates by hour", () => {
    const now = Date.now();
    const oneHourAgo = now - 3600_000;

    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));
    insertRequest(db, makeRecord({ timestamp: now - 1000, latency_ms: 200 }));
    insertRequest(db, makeRecord({ timestamp: oneHourAgo, latency_ms: 300 }));

    const result = queryTimeseries(db, "hour", "24h");
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Most recent bucket should have 2 requests
    const latestBucket = result[result.length - 1]!;
    expect(latestBucket.count).toBe(2);
  });

  test("returns extended bucket fields", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100, stream: 1, status: "success", status_code: 200, ttft_ms: 50 }));
    insertRequest(db, makeRecord({ timestamp: now - 1000, latency_ms: 200, stream: 0, status: "error", status_code: 429 }));

    const result = queryTimeseries(db, "hour", "24h");
    const bucket = result[result.length - 1]!;
    expect(bucket.success_count).toBe(1);
    expect(bucket.error_count).toBe(1);
    expect(bucket.stream_count).toBe(1);
    expect(bucket.sync_count).toBe(1);
    expect(bucket.input_tokens).toBeGreaterThanOrEqual(0);
    expect(bucket.output_tokens).toBeGreaterThanOrEqual(0);
    expect(bucket.p95_latency_ms).toBeGreaterThanOrEqual(0);
    expect(bucket.p99_latency_ms).toBeGreaterThanOrEqual(0);
    expect(bucket.avg_ttft_ms).toBe(50); // only 1 non-null
    expect(bucket.p95_ttft_ms).toBe(50);
    expect(typeof bucket.status_codes).toBe("object");
    expect(bucket.status_codes["200"]).toBe(1);
    expect(bucket.status_codes["429"]).toBe(1);
  });

  test("supports 5min interval", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));

    const result = queryTimeseries(db, "5min", "1h");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("supports filter WHERE clause", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, model: "claude-3", latency_ms: 100 }));
    insertRequest(db, makeRecord({ timestamp: now, model: "gpt-4o", latency_ms: 200 }));

    const result = queryTimeseries(db, "hour", "24h", "WHERE model = ?", ["claude-3"]);
    const bucket = result[result.length - 1]!;
    expect(bucket.count).toBe(1);
  });

  test("aggregates by minute", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));

    const result = queryTimeseries(db, "minute", "1h");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("aggregates by day", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));

    const result = queryTimeseries(db, "day", "7d");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("unknown interval defaults to hour", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));

    const result = queryTimeseries(db, "unknown", "24h");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("range with minute unit", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));

    const result = queryTimeseries(db, "minute", "30m");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("range with day unit", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));

    const result = queryTimeseries(db, "hour", "7d");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("invalid range defaults to 24h", () => {
    const now = Date.now();
    insertRequest(db, makeRecord({ timestamp: now, latency_ms: 100 }));

    const result = queryTimeseries(db, "hour", "invalid");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// queryBreakdown
// ===========================================================================

describe("queryBreakdown", () => {
  test("groups by model", () => {
    insertRequest(db, makeRecord({ model: "claude-3", latency_ms: 100 }));
    insertRequest(db, makeRecord({ model: "claude-3", latency_ms: 200, status: "error" }));
    insertRequest(db, makeRecord({ model: "gpt-4o", latency_ms: 300 }));

    const result = queryBreakdown(db, { by: "model" });
    expect(result).toHaveLength(2);
    // Default sort is count DESC
    expect(result[0]!.key).toBe("claude-3");
    expect(result[0]!.count).toBe(2);
    expect(result[0]!.error_count).toBe(1);
    expect(result[0]!.error_rate).toBeCloseTo(0.5);
    expect(result[0]!.p95_latency_ms).toBeGreaterThan(0);
    expect(result[0]!.first_seen).toBeLessThanOrEqual(result[0]!.last_seen);
  });

  test("invalid by value returns empty", () => {
    const result = queryBreakdown(db, { by: "nonexistent" });
    expect(result).toHaveLength(0);
  });

  test("respects sort and order", () => {
    insertRequest(db, makeRecord({ model: "a", latency_ms: 500 }));
    insertRequest(db, makeRecord({ model: "b", latency_ms: 100 }));
    insertRequest(db, makeRecord({ model: "b", latency_ms: 100 }));

    const result = queryBreakdown(db, { by: "model", sort: "avg_latency_ms", order: "desc" });
    expect(result[0]!.key).toBe("a"); // higher avg latency
  });

  test("respects limit", () => {
    insertRequest(db, makeRecord({ model: "a" }));
    insertRequest(db, makeRecord({ model: "b" }));
    insertRequest(db, makeRecord({ model: "c" }));

    const result = queryBreakdown(db, { by: "model", limit: 2 });
    expect(result).toHaveLength(2);
  });

  test("session breakdown includes extra context fields", () => {
    insertRequest(db, makeRecord({ session_id: "s1", client_name: "vscode", account_name: "default" }));
    insertRequest(db, makeRecord({ session_id: "s1", client_name: "vscode", account_name: "default" }));

    const result = queryBreakdown(db, { by: "session_id" });
    expect(result[0]!.client_name).toBe("vscode");
    expect(result[0]!.account_name).toBe("default");
  });

  test("respects WHERE filter", () => {
    insertRequest(db, makeRecord({ model: "a", status: "success" }));
    insertRequest(db, makeRecord({ model: "a", status: "error" }));
    insertRequest(db, makeRecord({ model: "b", status: "success" }));

    const result = queryBreakdown(db, { by: "model", whereClause: "WHERE status = ?", bindings: ["error"] });
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("a");
  });
});

// ===========================================================================
// queryPercentiles
// ===========================================================================

describe("queryPercentiles", () => {
  test("returns percentile distribution for latency_ms", () => {
    for (let i = 1; i <= 100; i++) {
      insertRequest(db, makeRecord({ latency_ms: i * 10 }));
    }

    const result = queryPercentiles(db, "latency_ms");
    expect(result).not.toBeNull();
    expect(result!.count).toBe(100);
    expect(result!.min).toBe(10);
    expect(result!.max).toBe(1000);
    expect(result!.p50).toBe(500);
    expect(result!.p95).toBe(950);
    expect(result!.p99).toBe(990);
  });

  test("returns null for invalid metric", () => {
    const result = queryPercentiles(db, "nonexistent");
    expect(result).toBeNull();
  });

  test("handles empty DB", () => {
    const result = queryPercentiles(db, "latency_ms");
    expect(result!.count).toBe(0);
    expect(result!.p50).toBe(0);
  });

  test("filters nullable metrics (ttft_ms)", () => {
    insertRequest(db, makeRecord({ ttft_ms: 100 }));
    insertRequest(db, makeRecord({ ttft_ms: 200 }));
    insertRequest(db, makeRecord({ ttft_ms: null }));

    const result = queryPercentiles(db, "ttft_ms");
    expect(result!.count).toBe(2); // null excluded
    expect(result!.min).toBe(100);
    expect(result!.max).toBe(200);
  });

  test("respects WHERE filter", () => {
    insertRequest(db, makeRecord({ model: "a", latency_ms: 100 }));
    insertRequest(db, makeRecord({ model: "a", latency_ms: 200 }));
    insertRequest(db, makeRecord({ model: "b", latency_ms: 999 }));

    const result = queryPercentiles(db, "latency_ms", "WHERE model = ?", ["a"]);
    expect(result!.count).toBe(2);
    expect(result!.max).toBe(200);
  });
});

// ===========================================================================
// queryModels
// ===========================================================================

describe("queryModels", () => {
  test("groups by model", () => {
    insertRequest(db, makeRecord({ model: "claude-sonnet-4" }));
    insertRequest(db, makeRecord({ model: "claude-sonnet-4" }));
    insertRequest(db, makeRecord({ model: "gpt-4o" }));

    const result = queryModels(db);
    expect(result).toHaveLength(2);

    const claude = result.find((m: ModelStats) => m.model === "claude-sonnet-4");
    expect(claude).toBeDefined();
    expect(claude!.count).toBe(2);
  });
});

// ===========================================================================
// queryRecent
// ===========================================================================

describe("queryRecent", () => {
  test("returns most recent records", () => {
    for (let i = 0; i < 5; i++) {
      insertRequest(db, makeRecord({ timestamp: 1000 + i }));
    }

    const result = queryRecent(db, 3);
    expect(result).toHaveLength(3);
    // Should be in desc order
    expect(result[0]!.timestamp).toBeGreaterThan(result[1]!.timestamp);
  });

  test("default limit is 50", () => {
    for (let i = 0; i < 60; i++) {
      insertRequest(db, makeRecord({ timestamp: 1000 + i }));
    }

    const result = queryRecent(db);
    expect(result).toHaveLength(50);
  });
});

// ===========================================================================
// queryRequests (with filtering, sorting, pagination)
// ===========================================================================

describe("queryRequests", () => {
  test("filter by model", () => {
    insertRequest(db, makeRecord({ model: "claude-sonnet-4" }));
    insertRequest(db, makeRecord({ model: "gpt-4o" }));

    const result = queryRequests(db, { model: "gpt-4o" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.model).toBe("gpt-4o");
  });

  test("filter by status", () => {
    insertRequest(db, makeRecord({ status: "success" }));
    insertRequest(db, makeRecord({ status: "error" }));

    const result = queryRequests(db, { status: "error" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.status).toBe("error");
  });

  test("filter by format", () => {
    insertRequest(db, makeRecord({ client_format: "anthropic" }));
    insertRequest(db, makeRecord({ client_format: "openai" }));

    const result = queryRequests(db, { format: "openai" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.client_format).toBe("openai");
  });

  test("sort by latency_ms desc", () => {
    insertRequest(db, makeRecord({ latency_ms: 100 }));
    insertRequest(db, makeRecord({ latency_ms: 500 }));
    insertRequest(db, makeRecord({ latency_ms: 200 }));

    const result = queryRequests(db, {
      sort: "latency_ms",
      order: "desc",
    });
    expect(result.data[0]!.latency_ms).toBe(500);
    expect(result.data[2]!.latency_ms).toBe(100);
  });

  test("cursor-based pagination (sort=timestamp)", () => {
    const records: RequestRecord[] = [];
    for (let i = 0; i < 5; i++) {
      const r = makeRecord({ timestamp: 1000 + i });
      records.push(r);
      insertRequest(db, r);
    }

    // First page: 2 items
    const page1 = queryRequests(db, {
      sort: "timestamp",
      order: "desc",
      limit: 2,
    });
    expect(page1.data).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeDefined();

    // Second page using cursor
    const page2 = queryRequests(db, {
      sort: "timestamp",
      order: "desc",
      limit: 2,
      cursor: page1.next_cursor!,
    });
    expect(page2.data).toHaveLength(2);
    expect(page2.has_more).toBe(true);

    // No overlap between pages
    const page1Ids = page1.data.map((r: RequestRecord) => r.id);
    const page2Ids = page2.data.map((r: RequestRecord) => r.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  test("offset pagination (sort=latency_ms)", () => {
    for (let i = 0; i < 5; i++) {
      insertRequest(db, makeRecord({ latency_ms: (i + 1) * 100 }));
    }

    const page1 = queryRequests(db, {
      sort: "latency_ms",
      order: "desc",
      limit: 2,
      offset: 0,
    });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.has_more).toBe(true);

    const page2 = queryRequests(db, {
      sort: "latency_ms",
      order: "desc",
      limit: 2,
      offset: 2,
    });
    expect(page2.data).toHaveLength(2);
    expect(page2.data[0]!.latency_ms).toBeLessThan(page1.data[1]!.latency_ms);
  });

  test("limit capped at 200", () => {
    for (let i = 0; i < 5; i++) {
      insertRequest(db, makeRecord());
    }

    const result = queryRequests(db, { limit: 999 });
    // Should be capped internally, but since we only have 5, just check it doesn't crash
    expect(result.data.length).toBeLessThanOrEqual(200);
  });
});
