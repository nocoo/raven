import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  apiKeyAuth,
} from "../src/middleware.ts";
import { createApiKey, updateApiKeyRule } from "../src/db/keys.ts";
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../src/core/routing-types.ts";
import { getCatalog, replaceCatalog } from "../src/db/catalog.ts";
import { createRoutingRule } from "../src/db/routing-rules.ts";
import { NOW, routingFixture, ruleInput } from "./db/routing-fixture.ts";

/** App with apiKeyAuth on /v1/* for AI route tests */
function createAiApp(db: Database, envApiKey: string | null = null) {
  const app = new Hono();
  const auth = apiKeyAuth({ db, envApiKey });
  app.use("/v1/*", auth);
  app.get("/v1/models", (c) => {
    const keyName = c.get("keyName");
    const keyId = c.get("keyId");
    return c.json({ keyName, keyId, ruleId: c.get("ruleId"), admittedAt: c.get("admittedAt"), usesRoutingDb: c.get("routingDb") === db });
  });
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }));
  return app;
}

let db: Database;
let fixture: ReturnType<typeof routingFixture>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fixture = routingFixture();
  db = fixture.db;
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Authentication must not call upstreams"));
});

afterEach(() => {
  fixture.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
      expect(body.keyId).toBe("env:default");
      expect(body).toMatchObject({ ruleId: COPILOT_RULE_ID, admittedAt: NOW, usesRoutingDb: true });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("DB key path (rk- prefix)", () => {
    test("accepts valid DB key, keyName = key name, keyId = api_keys.id", async () => {
      const rule = createRoutingRule(db, ruleInput());
      const created = createApiKey(db, "test-key", rule.id);
      const app = createAiApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyName).toBe("test-key");
      expect(body.keyId).toBe(created.id);
      expect(body).toMatchObject({ ruleId: rule.id, admittedAt: NOW, usesRoutingDb: true });
      expect(globalThis.fetch).not.toHaveBeenCalled();
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
      const created = createApiKey(db, "revoke-me", COPILOT_RULE_ID);
      revokeApiKey(db, created.id);
      const app = createAiApp(db);
      const res = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      });
      expect(res.status).toBe(401);
    });

    test("DB key + env key: each works independently", async () => {
      const created = createApiKey(db, "db-key", COPILOT_RULE_ID);
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

  test("captures admission once and applies a key rebind only to its later requests", async () => {
    const key = createApiKey(db, "shared-rule", COPILOT_RULE_ID);
    const other = createApiKey(db, "same-rule", COPILOT_RULE_ID);
    const replacement = createRoutingRule(db, ruleInput());
    let entered!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    const completion = new Promise<void>((resolve) => { release = resolve; });
    const pendingApp = new Hono();
    pendingApp.use("*", apiKeyAuth({ db, envApiKey: null }));
    pendingApp.get("/pending", async (c) => {
      entered();
      await completion;
      return c.json({ ruleId: c.get("ruleId"), admittedAt: c.get("admittedAt"), usesRoutingDb: c.get("routingDb") === db });
    });
    const pending = pendingApp.request("/pending", { headers: { "x-api-key": key.key } });
    await admitted;
    updateApiKeyRule(db, key.id, replacement.id);
    vi.setSystemTime(NOW + 60000);
    const app = createAiApp(db);
    const later = await app.request("/v1/models", { headers: { "x-api-key": key.key } });
    const unchanged = await app.request("/v1/models", { headers: { "x-api-key": other.key } });
    release();
    expect(await (await pending).json()).toEqual({ ruleId: COPILOT_RULE_ID, admittedAt: NOW, usesRoutingDb: true });
    expect(await later.json()).toMatchObject({ keyId: key.id, ruleId: replacement.id, admittedAt: NOW + 60000, usesRoutingDb: true });
    expect(await unchanged.json()).toMatchObject({ keyId: other.id, ruleId: COPILOT_RULE_ID });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test.each([{ models: [] }, { models: [{ id: "stale-model", supported_endpoints: ["/responses"] }] }])("authentication never refreshes catalog $models", async ({ models }) => {
    replaceCatalog(db, COPILOT_UPSTREAM_ID, models, NOW - 7200000);
    const key = createApiKey(db, "cached", COPILOT_RULE_ID);
    const app = createAiApp(db);
    expect((await app.request("/v1/models", { headers: { "x-api-key": key.key } })).status).toBe(200);
    expect(getCatalog(db, COPILOT_UPSTREAM_ID)).toEqual(models);
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
      const created = createApiKey(db, "x-api-key-test", COPILOT_RULE_ID);
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
