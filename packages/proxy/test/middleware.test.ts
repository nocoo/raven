import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  apiKeyAuth,
  dashboardAuth,
  invalidateKeyCountCache,
  ipWhitelistMiddleware,
} from "../src/middleware.ts";
import { initApiKeys, createApiKey } from "../src/db/keys.ts";
import { state } from "../src/lib/state.ts";
import { parseIPRange } from "../src/lib/ip-whitelist.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  initApiKeys(db);
  return db;
}

/** App with apiKeyAuth on /v1/* for AI route tests */
function createAiApp(db: Database, envApiKey: string | null = null) {
  const app = new Hono();
  const auth = apiKeyAuth({ db, envApiKey });
  app.use("/v1/*", auth);
  app.get("/v1/models", (c) => {
    const keyName = c.get("keyName");
    return c.json({ keyName });
  });
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }));
  return app;
}

/** App with dashboardAuth on /api/* for management route tests */
function createDashboardApp(db: Database, envApiKey: string | null = null, internalKey: string | null = null) {
  const app = new Hono();
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
  describe("dev mode (no env keys configured)", () => {
    test("allows request without auth, keyName = dev", async () => {
      const app = createDashboardApp(db);
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("dev");
    });

    test("dev mode persists even when active DB keys exist", async () => {
      createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createDashboardApp(db); // no env keys
      const res = await app.request("/api/stats/overview");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("dev");
    });

    test("dev mode with DB key: DB key also accepted as Bearer", async () => {
      const created = createApiKey(db, "some-key");
      invalidateKeyCountCache();
      const app = createDashboardApp(db); // no env keys → dev mode
      const res = await app.request("/api/stats/overview", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      // Dev mode allows without auth, but Bearer also works
      expect(res.status).toBe(200);
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
});

// ===========================================================================
// x-api-key header authentication (Claude Code compatibility)
// ===========================================================================

describe("x-api-key header authentication", () => {
  describe("apiKeyAuth accepts x-api-key", () => {
    test("accepts env key via x-api-key header", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { "x-api-key": "sk-raven-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("env:default");
    });

    test("accepts DB key (rk- prefix) via x-api-key header", async () => {
      const created = createApiKey(db, "x-api-key-test");
      invalidateKeyCountCache();
      const app = createAiApp(db);
      const res = await app.request("/v1/models", {
        headers: { "x-api-key": created.key },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("x-api-key-test");
    });

    test("rejects wrong token via x-api-key → 401", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { "x-api-key": "wrong-key" },
      });
      expect(res.status).toBe(401);
    });

    test("rejects request with no keys configured and only x-api-key → 401", async () => {
      const app = createAiApp(db); // no env key, no DB keys
      const res = await app.request("/v1/models", {
        headers: { "x-api-key": "anything" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("Authorization: Bearer takes precedence over x-api-key", () => {
    test("uses Bearer token when both headers present", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: {
          Authorization: "Bearer sk-raven-secret",
          "x-api-key": "wrong-key",
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("env:default");
    });

    test("fails on invalid Bearer even when x-api-key is valid", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: {
          Authorization: "Bearer wrong-key",
          "x-api-key": "sk-raven-secret",
        },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("dashboardAuth accepts x-api-key", () => {
    test("accepts env key via x-api-key for dashboard routes", async () => {
      const app = createDashboardApp(db, "sk-raven-secret");
      const res = await app.request("/api/stats/overview", {
        headers: { "x-api-key": "sk-raven-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("env:default");
    });

    test("accepts internal key via x-api-key for dashboard routes", async () => {
      const app = createDashboardApp(db, undefined, "internal-secret");
      const res = await app.request("/api/stats/overview", {
        headers: { "x-api-key": "internal-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("internal");
    });
  });

  describe("apiKeyAuth rejects internal key via x-api-key", () => {
    test("rejects RAVEN_INTERNAL_KEY via x-api-key — cannot consume Copilot quota", async () => {
      const app = createAiApp(db, "sk-raven-secret");
      const res = await app.request("/v1/models", {
        headers: { "x-api-key": "internal-secret" },
      });
      expect(res.status).toBe(401);
    });
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

// ===========================================================================
// ipWhitelistMiddleware — IP-based access control
// ===========================================================================

describe("ipWhitelistMiddleware", () => {
  // Save original state
  let originalEnabled: boolean;
  let originalRanges: typeof state.ipWhitelistRanges;

  beforeEach(() => {
    originalEnabled = state.ipWhitelistEnabled;
    originalRanges = state.ipWhitelistRanges;
  });

  afterEach(() => {
    state.ipWhitelistEnabled = originalEnabled;
    state.ipWhitelistRanges = originalRanges;
  });

  function createWhitelistApp() {
    const app = new Hono();
    app.use("*", ipWhitelistMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));
    return app;
  }

  describe("disabled (default)", () => {
    test("allows all requests when whitelist is disabled", async () => {
      state.ipWhitelistEnabled = false;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    });
  });

  describe("enabled with no ranges", () => {
    test("allows all requests when no ranges configured (fail-open)", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [];
      const app = createWhitelistApp();
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    });
  });

  describe("enabled with ranges", () => {
    test("allows request with whitelisted x-forwarded-for IP", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      });
      expect(res.status).toBe(200);
    });

    test("rejects request with non-whitelisted x-forwarded-for IP", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(res.status).toBe(403);
    });

    test("handles x-forwarded-for with multiple IPs (uses first)", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.50, 10.0.0.1, 8.8.8.8" },
      });
      expect(res.status).toBe(200);
    });

    test("allows request with whitelisted x-real-ip", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("10.0.0.1")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-real-ip": "10.0.0.1" },
      });
      expect(res.status).toBe(200);
    });

    test("rejects request with non-whitelisted x-real-ip", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("10.0.0.1")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-real-ip": "10.0.0.2" },
      });
      expect(res.status).toBe(403);
    });

    test("handles IPv6-mapped IPv4 (::ffff:x.x.x.x)", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "::ffff:192.168.1.100" },
      });
      expect(res.status).toBe(200);
    });

    test("handles IPv6 loopback (::1) as 127.0.0.1", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("127.0.0.1")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "::1" },
      });
      expect(res.status).toBe(200);
    });

    test("rejects pure IPv6 addresses", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [parseIPRange("0.0.0.0/0")!]; // Allow all IPv4
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "2001:db8::1" },
      });
      expect(res.status).toBe(403);
    });

    test("checks against multiple ranges (any match passes)", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistRanges = [
        parseIPRange("192.168.1.0/24")!,
        parseIPRange("10.0.0.0/8")!,
        parseIPRange("172.16.0.1")!,
      ];
      const app = createWhitelistApp();

      const res1 = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/test", {
        headers: { "x-forwarded-for": "10.255.255.255" },
      });
      expect(res2.status).toBe(200);

      const res3 = await app.request("/test", {
        headers: { "x-forwarded-for": "172.16.0.1" },
      });
      expect(res3.status).toBe(200);

      const res4 = await app.request("/test", {
        headers: { "x-forwarded-for": "8.8.8.8" },
      });
      expect(res4.status).toBe(403);
    });
  });
});
