import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  dbKeyAuth,
  requestContext,
  invalidateKeyCountCache,
} from "../src/middleware.ts";
import { initApiKeys, createApiKey } from "../src/db/keys.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  initApiKeys(db);
  return db;
}

function createTestApp(db: Database) {
  const app = new Hono();
  app.use("*", requestContext());
  app.use("/v1/*", dbKeyAuth({ db }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/v1/models", (c) => {
    const requestId = c.get("requestId");
    const startTime = c.get("startTime");
    const keyName = c.get("keyName");
    return c.json({ requestId, startTime, keyName });
  });
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }));
  app.get("/api/stats/overview", (c) => c.json({ ok: true }));
  return app;
}

let db: Database;

beforeEach(() => {
  db = createTestDb();
  invalidateKeyCountCache();
});

afterEach(() => {
  db.close();
});

describe("dbKeyAuth middleware", () => {
  describe("dev mode (no DB keys)", () => {
    test("accepts all requests, keyName = dev", async () => {
      const app = createTestApp(db);
      const res = await app.request("/v1/models");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("dev");
    });
  });

  describe("DB key path", () => {
    test("accepts valid DB key, keyName = key name", async () => {
      const created = createApiKey(db, "test-key");
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("test-key");
    });

    test("rejects invalid key", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer rk-0000000000000000000000000000000000000000000000000000000000000000" },
      });
      expect(res.status).toBe(401);
    });

    test("rejects request without Authorization header", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/v1/models");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.type).toBe("authentication_error");
    });

    test("rejects malformed Authorization header", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: "some-token-no-bearer" },
      });
      expect(res.status).toBe(401);
    });

    test("rejects revoked DB key", async () => {
      const { revokeApiKey } = await import("../src/db/keys.ts");
      const created = createApiKey(db, "revoke-me");
      revokeApiKey(db, created.id);
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res.status).toBe(401);
    });

    test("DB key presence disables dev mode", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/v1/models");
      // No Authorization header → should be 401, not dev mode
      expect(res.status).toBe(401);
    });
  });

  describe("route scoping", () => {
    test("does not protect /health", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    });

    test("does not protect /api/* (dashboard internal)", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createTestApp(db);
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(200);
    });
  });
});

describe("requestContext middleware", () => {
  test("injects requestId and startTime", async () => {
    const app = createTestApp(db);
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBeString();
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(body.startTime).toBeNumber();
    expect(body.startTime).toBeGreaterThan(0);
  });

  test("generates unique requestIds", async () => {
    const app = createTestApp(db);
    const res1 = await app.request("/v1/models");
    const res2 = await app.request("/v1/models");
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.requestId).not.toBe(body2.requestId);
  });
});
