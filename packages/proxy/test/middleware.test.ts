import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  apiKeyAuth,
  dashboardAuth,
  requestContext,
  invalidateKeyCountCache,
} from "../src/middleware.ts";
import { initApiKeys, createApiKey } from "../src/db/keys.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  initApiKeys(db);
  return db;
}

/** App with apiKeyAuth on /v1/* for AI route tests */
function createAiApp(db: Database, envApiKey?: string) {
  const app = new Hono();
  app.use("*", requestContext());
  const auth = apiKeyAuth({ db, envApiKey });
  app.use("/v1/*", auth);
  app.get("/v1/models", (c) => {
    const startTime = c.get("startTime");
    const keyName = c.get("keyName");
    return c.json({ startTime, keyName });
  });
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }));
  return app;
}

/** App with dashboardAuth on /api/* for management route tests */
function createDashboardApp(db: Database, envApiKey?: string, internalKey?: string) {
  const app = new Hono();
  app.use("*", requestContext());
  const auth = dashboardAuth({ db, envApiKey, internalKey });
  app.use("/api/*", auth);
  app.get("/api/stats/overview", (c) => {
    const keyName = c.get("keyName");
    return c.json({ ok: true, keyName });
  });
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

// ===========================================================================
// apiKeyAuth — strict auth for AI coding routes
// ===========================================================================

describe("apiKeyAuth middleware", () => {
  describe("no keys configured (no dev mode)", () => {
    test("rejects request without auth → 401", async () => {
      const app = createAiApp(db);
      const res = await app.request("/v1/models");
      expect(res.status).toBe(401);
    });

    test("rejects request even with no Authorization header", async () => {
      const app = createAiApp(db);
      const res = await app.request("/v1/chat/completions", { method: "POST" });
      expect(res.status).toBe(401);
    });
  });

  describe("env key only (no DB keys)", () => {
    test("rejects request without Authorization header", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.type).toBe("authentication_error");
    });

    test("rejects request with wrong API key", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer wrong-key" },
      });
      expect(res.status).toBe(401);
    });

    test("rejects request with malformed Authorization header", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "sk-raven-secret" },
      });
      expect(res.status).toBe(401);
    });

    test("accepts request with correct env API key, keyName = env:default", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer sk-raven-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("env:default");
    });
  });

  describe("DB key path (rk- prefix)", () => {
    test("accepts valid DB key, keyName = key name", async () => {
      const created = createApiKey(db, "test-key");
      invalidateKeyCountCache();
      const app = createAiApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("test-key");
    });

    test("rejects invalid rk- key (no fallback to env)", async () => {
      const app = createAiApp(db, "sk-raven-secret");
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
      const app = createAiApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res.status).toBe(401);
    });

    test("DB key + env key: each works independently", async () => {
      const created = createApiKey(db, "db-key");
      invalidateKeyCountCache();
      const app = createAiApp(db, "sk-raven-secret");

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

  describe("RAVEN_INTERNAL_KEY rejection", () => {
    test("rejects RAVEN_INTERNAL_KEY — cannot consume Copilot quota", async () => {
      // apiKeyAuth does not accept internal key
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer internal-secret" },
      });
      expect(res.status).toBe(401);
    });
  });
});

// ===========================================================================
// dashboardAuth — management routes with dev mode for bootstrap
// ===========================================================================

describe("dashboardAuth middleware", () => {
  describe("dev mode (no env keys, no active DB keys)", () => {
    test("allows request without auth, keyName = dev", async () => {
      const app = createDashboardApp(db);
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("dev");
    });

    test("only revoked DB keys → dev mode (anti-lockout)", async () => {
      const { revokeApiKey } = await import("../src/db/keys.ts");
      const created = createApiKey(db, "revoke-me");
      revokeApiKey(db, created.id);
      invalidateKeyCountCache();
      const app = createDashboardApp(db);
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("dev");
    });
  });

  describe("dev mode disabled by RAVEN_API_KEY", () => {
    test("requires Bearer when env key is set", async () => {
      const app = createDashboardApp(db, "sk-raven-secret");
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(401);
    });

    test("accepts valid env key", async () => {
      const app = createDashboardApp(db, "sk-raven-secret");
      const res = await app.request("/api/stats/overview", {
        headers: { Authorization: "Bearer sk-raven-secret" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("dev mode disabled by RAVEN_INTERNAL_KEY", () => {
    test("requires Bearer when internal key is set", async () => {
      const app = createDashboardApp(db, undefined, "internal-secret");
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(401);
    });

    test("accepts valid internal key, keyName = internal", async () => {
      const app = createDashboardApp(db, undefined, "internal-secret");
      const res = await app.request("/api/stats/overview", {
        headers: { Authorization: "Bearer internal-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("internal");
    });
  });

  describe("dev mode disabled by active DB key", () => {
    test("requires Bearer when active DB key exists", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createDashboardApp(db);
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(401);
    });

    test("accepts valid DB key", async () => {
      const created = createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createDashboardApp(db);
      const res = await app.request("/api/stats/overview", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res.status).toBe(200);
    });
  });
});

// ===========================================================================
// requestContext middleware
// ===========================================================================

describe("requestContext middleware", () => {
  test("injects startTime", async () => {
    const app = createAiApp(db, "sk-test");
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.startTime).toBeNumber();
    expect(body.startTime).toBeGreaterThan(0);
  });

  test("generates unique startTimes per request", async () => {
    const app = createAiApp(db, "sk-test");
    const res1 = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-test" },
    });
    await new Promise((r) => setTimeout(r, 1));
    const res2 = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-test" },
    });
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.startTime).not.toBe(body2.startTime);
  });
});

// ===========================================================================
// timing-safe comparison
// ===========================================================================

describe("timing-safe comparison", () => {
  test("rejects keys of different length", async () => {
    const app = createAiApp(db, "sk-raven-secret");
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer short" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects keys of same length but different content", async () => {
    const app = createAiApp(db, "sk-raven-secret");
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer sk-raven-secre!" },
    });
    expect(res.status).toBe(401);
  });
});
