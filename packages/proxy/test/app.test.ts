import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import type { Database } from "bun:sqlite"
import { createApp } from "../src/app.ts"
import { initDatabase } from "../src/db/requests.ts"
import { createApiKey } from "../src/db/keys.ts"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../src/core/routing-types.ts"
import { replaceCatalog } from "../src/db/catalog.ts"
import { getProvider } from "../src/db/providers.ts"
import { state } from "../src/lib/state.ts"
import { NOW, routingFixture, ruleInput } from "./db/routing-fixture.ts"

// ===========================================================================
// createApp factory wiring
// ===========================================================================

describe("createApp", () => {
  let db: Database
  let fixture: ReturnType<typeof routingFixture>
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let saved: typeof state

  beforeEach(() => {
    saved = { ...state }
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("App wiring and cache reads must not call upstreams"))
    fixture = routingFixture()
    db = fixture.db
    initDatabase(db)
    state.corsEnabled = false
    state.corsAllowedOrigins = []
    state.ipWhitelistEnabled = false
    state.models = null
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    Object.assign(state, saved)
    fixture.close()
  })

  test("returns a Hono app", () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    expect(app).toBeDefined()
    expect(typeof app.fetch).toBe("function")
  })

  test("GET /health returns 200", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: "ok" })
  })

  test("health endpoint is NOT auth-protected", async () => {
    const app = createApp({ db, apiKey: "secret", internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/health")
    expect(res.status).toBe(200)
  })

  // -----------------------------------------------------------------------
  // AI routes — apiKeyAuth (strict, no dev mode)
  // -----------------------------------------------------------------------

  test("/v1/* returns 401 when no keys configured (no dev mode)", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/v1/models")
    expect(res.status).toBe(401)
  })

  test("/v1/* is auth-protected when apiKey is set", async () => {
    const app = createApp({ db, apiKey: "secret", internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/v1/models")
    expect(res.status).toBe(401)
  })

  test("/v1/* allows access with correct apiKey", async () => {
    const app = createApp({ db, apiKey: "secret", internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer secret" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ object: "list", has_more: false, data: [{ id: "auto", object: "model", owned_by: "raven" }] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("/v1/* rejects RAVEN_INTERNAL_KEY", async () => {
    const app = createApp({ db, apiKey: "secret", internalKey: "internal", githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer internal" },
    })
    expect(res.status).toBe(401)
  })

  // -----------------------------------------------------------------------
  // Aliases — same auth as /v1/* routes
  // -----------------------------------------------------------------------

  test("/chat/completions without key → 401", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/chat/completions", { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("/chat/completions authenticates a bound key before rejecting invalid JSON", async () => {
    const created = createApiKey(db, "test-key", COPILOT_RULE_ID)
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${created.key}` },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { message: "Invalid JSON" } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("/embeddings without key → 401", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/embeddings", { method: "POST" })
    expect(res.status).toBe(401)
  })

  // -----------------------------------------------------------------------
  // Dashboard routes — local management
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  test("dashboard stats endpoints are mounted at /api/stats/*", async () => {
    const app = createApp({ db, apiKey: null, internalKey: "internal", githubToken: "gh-test", port: null, baseUrl: null })

    const endpoints = [
      "/api/stats/overview",
      "/api/stats/models",
      "/api/stats/recent?limit=1",
    ]

    for (const path of endpoints) {
      const res = await app.request(path, { headers: { Authorization: "Bearer internal" } }, { remoteAddress: "::1" })
      expect(res.status).toBe(200)
    }
  })

  test("connection-info endpoint returns correct structure", async () => {
    const app = createApp({ db, apiKey: null, internalKey: "internal", githubToken: "gh-test", port: 7024, baseUrl: null })
    const res = await app.request("/api/connection-info", { headers: { Authorization: "Bearer internal" } }, { remoteAddress: "::1" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.endpoints).toBeDefined()
    expect(body.endpoints.chat_completions).toBe("/v1/chat/completions")
    expect(body.endpoints.messages).toBe("/v1/messages")
    expect(body.models).toEqual(["auto"])
    expect(body.model_list).toEqual([{ id: "auto", owned_by: "raven" }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("model and Connect routes project the same stale persisted catalog without discovery", async () => {
    const snapshot = [{ id: "raw/fixture-model", vendor: "fixture-vendor", supported_endpoints: ["/responses"] }]
    replaceCatalog(db, COPILOT_UPSTREAM_ID, snapshot, NOW - 7200000)
    const app = createApp({ db, apiKey: "client", internalKey: "internal", githubToken: "gh-test" })
    const models = await app.request("/v1/models", { headers: { Authorization: "Bearer client" } })
    const connect = await app.request("/api/connection-info", { headers: { Authorization: "Bearer internal" } }, { remoteAddress: "::1" })
    expect(models.status).toBe(200)
    expect(connect.status).toBe(200)
    expect(await models.json()).toEqual({ object: "list", has_more: false, data: [
      { id: "auto", object: "model", owned_by: "raven" },
      { ...snapshot[0], object: "model", owned_by: "fixture-vendor" },
    ] })
    expect(await connect.json()).toMatchObject({ models: ["auto", "raw/fixture-model"], model_list: [
      { id: "auto", owned_by: "raven" }, { id: "raw/fixture-model", owned_by: "fixture-vendor" },
    ] })
    expect(getProvider(db, COPILOT_UPSTREAM_ID)?.models).toEqual(snapshot)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("mounts rule creation and mandatory key binding with authenticated rebinding", async () => {
    const app = createApp({ db, apiKey: "client", internalKey: "internal", githubToken: "gh-test" })
    const headers = { Authorization: "Bearer internal", "content-type": "application/json" }
    const ruleResponse = await app.request("/api/routing-rules", { method: "POST", headers, body: JSON.stringify(ruleInput()) }, { remoteAddress: "::1" })
    expect(ruleResponse.status).toBe(201)
    const rule = await ruleResponse.json()
    expect(rule.allow_conversion).toBe(false)
    const missingBinding = await app.request("/api/keys", { method: "POST", headers, body: JSON.stringify({ name: "Editor" }) }, { remoteAddress: "::1" })
    expect(missingBinding.status).toBe(400)
    const createdResponse = await app.request("/api/keys", { method: "POST", headers, body: JSON.stringify({ name: "Editor", rule_id: rule.id }) }, { remoteAddress: "::1" })
    expect(createdResponse.status).toBe(201)
    const key = await createdResponse.json()
    expect(key.rule_id).toBe(rule.id)
    const rebound = await app.request(`/api/keys/${key.id}`, { method: "PATCH", headers, body: JSON.stringify({ rule_id: COPILOT_RULE_ID }) }, { remoteAddress: "::1" })
    expect(rebound.status).toBe(200)
    expect(await rebound.json()).toMatchObject({ id: key.id, rule_id: COPILOT_RULE_ID })
    expect((await app.request("/v1/models", { headers: { "x-api-key": key.key } })).status).toBe(200)
    expect((await app.request(`/api/routing-rules/${rule.id}`, { method: "DELETE", headers }, { remoteAddress: "::1" })).status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // CORS middleware behavior
  // -----------------------------------------------------------------------

  describe("CORS middleware", () => {
    test("allows any origin when CORS is disabled", async () => {
      state.corsEnabled = false
      const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
      const res = await app.request("/health", {
        headers: { Origin: "http://evil.com" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("http://evil.com")
    })

    test("allows any origin when CORS enabled but list is empty", async () => {
      state.corsEnabled = true
      state.corsAllowedOrigins = []
      const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
      const res = await app.request("/health", {
        headers: { Origin: "http://anything.com" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("http://anything.com")
    })

    test("allows whitelisted origin when CORS enabled with list", async () => {
      state.corsEnabled = true
      state.corsAllowedOrigins = ["http://localhost:3000", "https://app.example.com"]
      const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
      const res = await app.request("/health", {
        headers: { Origin: "http://localhost:3000" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    })

    test("blocks non-whitelisted origin when CORS enabled with list", async () => {
      state.corsEnabled = true
      state.corsAllowedOrigins = ["http://localhost:3000"]
      const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
      const res = await app.request("/health", {
        headers: { Origin: "http://evil.com" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).not.toBe("http://evil.com")
    })

    test("CORS preflight returns correct origin for whitelisted origin", async () => {
      state.corsEnabled = true
      state.corsAllowedOrigins = ["http://localhost:3000"]
      const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
      const res = await app.request("/health", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "GET",
        },
      })
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    })
  })
})
