import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  multiKeyAuth,
  requestContext,
  invalidateKeyCountCache,
} from "../src/middleware.ts";
import { initApiKeys, createApiKey } from "../src/db/keys.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  initApiKeys(db);
  return db;
}

function createTestApp(db: Database, envApiKey?: string) {
  const app = new Hono();
  app.use("*", requestContext());
  const auth = multiKeyAuth({ db, envApiKey });
  app.use("/v1/*", auth);
  app.use("/api/*", auth);
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

describe("multiKeyAuth middleware", () => {
  describe("dev mode (no env key, no DB keys)", () => {
    test("accepts all requests, keyName = dev", async () => {
      const app = createTestApp(db);
      const res = await app.request("/v1/models");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("dev");
    });
  });

  describe("env key only (no DB keys)", () => {
    test("rejects request without Authorization header", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.type).toBe("authentication_error");
    });

    test("rejects request with wrong API key", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer wrong-key" },
      });
      expect(res.status).toBe(401);
    });

    test("rejects request with malformed Authorization header", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "sk-raven-secret" },
      });
      expect(res.status).toBe(401);
    });

    test("accepts request with correct env API key, keyName = env:default", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer sk-raven-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("env:default");
    });

    test("protects /api/* routes", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(401);
    });

    test("allows /api/* with correct env key", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/api/stats/overview", {
        headers: { Authorization: "Bearer sk-raven-secret" },
      });
      expect(res.status).toBe(200);
    });

    test("does not protect /health", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    });
  });

  describe("DB key path (rk- prefix)", () => {
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

    test("rejects invalid rk- key (no fallback to env)", async () => {
      const app = createTestApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer rk-0000000000000000000000000000000000000000000000000000000000000000" },
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

    test("DB key presence disables dev mode (no env key)", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createTestApp(db); // no env key
      const res = await app.request("/v1/models");
      // No Authorization header → should be 401, not dev mode
      expect(res.status).toBe(401);
    });

    test("DB key + env key: rk- uses DB path, non-rk uses env path", async () => {
      const created = createApiKey(db, "db-key");
      invalidateKeyCountCache();
      const app = createTestApp(db, "sk-raven-secret");

      // rk- token → DB path
      const res1 = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.keyName).toBe("db-key");

      // env token → env path
      const res2 = await app.request("/v1/models", {
        headers: { Authorization: "Bearer sk-raven-secret" },
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.keyName).toBe("env:default");
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

describe("timing-safe comparison", () => {
  test("rejects keys of different length", async () => {
    const app = createTestApp(db, "sk-raven-secret");
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer short" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects keys of same length but different content", async () => {
    const app = createTestApp(db, "sk-raven-secret");
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-raven-secre!" },
    });
    expect(res.status).toBe(401);
  });
});
