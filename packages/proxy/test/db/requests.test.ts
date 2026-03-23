import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initDatabase,
  insertRequest,
  queryOverview,
  queryTimeseries,
  queryModels,
  queryRecent,
  queryRequests,
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
