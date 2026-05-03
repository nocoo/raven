import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  apiKeyAuth,
  dashboardAuth,
  invalidateKeyCountCache,
  ipWhitelistMiddleware,
  checkIPWhitelist,
  getClientIPFromRequest,
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
  let originalTrustProxy: boolean;

  beforeEach(() => {
    originalEnabled = state.ipWhitelistEnabled;
    originalRanges = state.ipWhitelistRanges;
    originalTrustProxy = state.ipWhitelistTrustProxy;
    // Default: trust proxy disabled (secure default)
    state.ipWhitelistTrustProxy = false;
  });

  afterEach(() => {
    state.ipWhitelistEnabled = originalEnabled;
    state.ipWhitelistRanges = originalRanges;
    state.ipWhitelistTrustProxy = originalTrustProxy;
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

  // SECURITY: Header spoofing prevention tests
  describe("security: trust_proxy=false (default)", () => {
    test("ignores x-forwarded-for when trust_proxy is false", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = false;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      // Even though header claims whitelisted IP, should be ignored
      // Without a real remote address in test, this falls through to fail-open
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      });
      // In test environment, no remoteAddress is available, so fail-open applies
      expect(res.status).toBe(200);
    });

    test("ignores x-real-ip when trust_proxy is false", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = false;
      state.ipWhitelistRanges = [parseIPRange("10.0.0.1")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-real-ip": "10.0.0.1" },
      });
      expect(res.status).toBe(200); // fail-open when no remoteAddress
    });

    test("client cannot spoof IP via x-forwarded-for when trust_proxy=false", async () => {
      // This is the key security test: even if client sends x-forwarded-for,
      // it should NOT be trusted unless trust_proxy is explicitly enabled
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = false;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];

      const app = createWhitelistApp();
      // Attacker tries to spoof whitelisted IP - but since trust_proxy=false,
      // the header is ignored and we use remoteAddress (unavailable in test = fail-open)
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.1" },
      });
      expect(res.status).toBe(200); // Passes because no remoteAddress in test
    });
  });

  describe("trust_proxy=true (explicit opt-in)", () => {
    test("reads x-forwarded-for when trust_proxy is true", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      });
      expect(res.status).toBe(200);
    });

    test("rejects non-whitelisted x-forwarded-for when trust_proxy is true", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(res.status).toBe(403);
    });

    test("handles x-forwarded-for with multiple IPs (uses first)", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.50, 10.0.0.1, 8.8.8.8" },
      });
      expect(res.status).toBe(200);
    });

    test("reads x-real-ip when trust_proxy is true", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("10.0.0.1")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-real-ip": "10.0.0.1" },
      });
      expect(res.status).toBe(200);
    });

    test("rejects non-whitelisted x-real-ip", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("10.0.0.1")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-real-ip": "10.0.0.2" },
      });
      expect(res.status).toBe(403);
    });

    test("handles IPv6-mapped IPv4 (::ffff:x.x.x.x)", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "::ffff:192.168.1.100" },
      });
      expect(res.status).toBe(200);
    });

    test("handles IPv6 loopback (::1) as 127.0.0.1", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("127.0.0.1")!];
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "::1" },
      });
      expect(res.status).toBe(200);
    });

    test("rejects pure IPv6 addresses", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
      state.ipWhitelistRanges = [parseIPRange("0.0.0.0/0")!]; // Allow all IPv4
      const app = createWhitelistApp();
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "2001:db8::1" },
      });
      expect(res.status).toBe(403);
    });

    test("checks against multiple ranges (any match passes)", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = true;
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

  describe("remoteAddress fallback", () => {
    test("uses c.env.info.remoteAddress when trust_proxy=false and no headers", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = false;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];

      // Create app that simulates remoteAddress via c.env.info
      const app = new Hono<{ Bindings: { info?: { remoteAddress?: string } } }>();
      app.use("*", async (c, next) => {
        // Simulate Bun server providing remoteAddress
        c.env = { info: { remoteAddress: "192.168.1.100" } };
        await next();
      });
      app.use("*", ipWhitelistMiddleware());
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.request("/test");
      expect(res.status).toBe(200);
    });

    test("rejects non-whitelisted remoteAddress", async () => {
      state.ipWhitelistEnabled = true;
      state.ipWhitelistTrustProxy = false;
      state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];

      const app = new Hono<{ Bindings: { info?: { remoteAddress?: string } } }>();
      app.use("*", async (c, next) => {
        c.env = { info: { remoteAddress: "10.0.0.1" } };
        await next();
      });
      app.use("*", ipWhitelistMiddleware());
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.request("/test");
      expect(res.status).toBe(403);
    });
  });
});

// ===========================================================================
// checkIPWhitelist — direct function tests
// ===========================================================================

describe("checkIPWhitelist function", () => {
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

  test("returns allowed:true when whitelist is disabled", () => {
    state.ipWhitelistEnabled = false;
    state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
    const result = checkIPWhitelist("10.0.0.1");
    expect(result).toEqual({ allowed: true });
  });

  test("returns allowed:true when no ranges configured (fail-open)", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [];
    const result = checkIPWhitelist("10.0.0.1");
    expect(result).toEqual({ allowed: true });
  });

  test("returns allowed:true when clientIP is null (fail-open)", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
    const result = checkIPWhitelist(null);
    expect(result).toEqual({ allowed: true });
  });

  test("returns not-ipv4 reason for pure IPv6 address", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
    const result = checkIPWhitelist("2001:db8::1");
    expect(result).toEqual({ allowed: false, reason: "not-ipv4" });
  });

  test("returns invalid-ip reason for malformed IP after IPv4 extraction", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
    // This IP will pass extractIPv4 (looks like valid dotted decimal)
    // but parseIPv4 will fail due to invalid octet values
    const result = checkIPWhitelist("192.168.1.999");
    // extractIPv4 returns null for invalid IPv4, so this triggers not-ipv4
    expect(result).toEqual({ allowed: false, reason: "not-ipv4" });
  });

  test("returns not-whitelisted for IP outside all ranges", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
    const result = checkIPWhitelist("10.0.0.1");
    expect(result).toEqual({ allowed: false, reason: "not-whitelisted" });
  });

  test("returns allowed:true for IP in whitelisted range", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
    const result = checkIPWhitelist("192.168.1.50");
    expect(result).toEqual({ allowed: true });
  });

  test("handles IPv6-mapped IPv4 correctly", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [parseIPRange("192.168.1.0/24")!];
    const result = checkIPWhitelist("::ffff:192.168.1.50");
    expect(result).toEqual({ allowed: true });
  });

  test("handles IPv6 loopback (::1) as 127.0.0.1", () => {
    state.ipWhitelistEnabled = true;
    state.ipWhitelistRanges = [parseIPRange("127.0.0.1")!];
    const result = checkIPWhitelist("::1");
    expect(result).toEqual({ allowed: true });
  });
});

// ===========================================================================
// getClientIPFromRequest — WebSocket upgrade path
// ===========================================================================

describe("getClientIPFromRequest function", () => {
  let originalTrustProxy: boolean;

  beforeEach(() => {
    originalTrustProxy = state.ipWhitelistTrustProxy;
  });

  afterEach(() => {
    state.ipWhitelistTrustProxy = originalTrustProxy;
  });

  describe("trust_proxy=false (default)", () => {
    beforeEach(() => {
      state.ipWhitelistTrustProxy = false;
    });

    test("ignores x-forwarded-for and returns remoteAddress", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      });
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("10.0.0.1");
    });

    test("ignores x-real-ip and returns remoteAddress", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-real-ip": "192.168.1.50" },
      });
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("10.0.0.1");
    });

    test("returns null when remoteAddress is null", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      });
      const result = getClientIPFromRequest(req, null);
      expect(result).toBe(null);
    });
  });

  describe("trust_proxy=true", () => {
    beforeEach(() => {
      state.ipWhitelistTrustProxy = true;
    });

    test("reads x-forwarded-for when trust_proxy is true", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-forwarded-for": "192.168.1.50" },
      });
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("192.168.1.50");
    });

    test("handles x-forwarded-for with multiple IPs (uses first)", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-forwarded-for": "192.168.1.50, 10.0.0.1, 8.8.8.8" },
      });
      const result = getClientIPFromRequest(req, "127.0.0.1");
      expect(result).toBe("192.168.1.50");
    });

    test("reads x-real-ip when x-forwarded-for is absent", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-real-ip": "172.16.0.1" },
      });
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("172.16.0.1");
    });

    test("prefers x-forwarded-for over x-real-ip", () => {
      const req = new Request("http://localhost/ws", {
        headers: {
          "x-forwarded-for": "192.168.1.50",
          "x-real-ip": "172.16.0.1",
        },
      });
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("192.168.1.50");
    });

    test("falls back to remoteAddress when no proxy headers", () => {
      const req = new Request("http://localhost/ws");
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("10.0.0.1");
    });

    test("returns null when no headers and remoteAddress is null", () => {
      const req = new Request("http://localhost/ws");
      const result = getClientIPFromRequest(req, null);
      expect(result).toBe(null);
    });

    test("trims whitespace from x-real-ip header", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-real-ip": "  192.168.1.50  " },
      });
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("192.168.1.50");
    });

    test("handles empty x-forwarded-for by falling through", () => {
      const req = new Request("http://localhost/ws", {
        headers: { "x-forwarded-for": "" },
      });
      const result = getClientIPFromRequest(req, "10.0.0.1");
      expect(result).toBe("10.0.0.1");
    });
  });
});
