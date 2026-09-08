import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Database } from "bun:sqlite"
import { createApp } from "../src/app.ts"
import { initDatabase } from "../src/db/requests.ts"
import { initApiKeys, createApiKey } from "../src/db/keys.ts"
import { invalidateKeyCountCache } from "../src/middleware.ts"
import { state } from "../src/lib/state.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:")
  initDatabase(db)
  initApiKeys(db)
  return db
}

// ===========================================================================
// createApp factory wiring
// ===========================================================================

describe("createApp", () => {
  let db: Database
  let fetchSpy: ReturnType<typeof vi.spyOn>
  const savedModels = state.models

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ object: "list", data: [] }),
    )
    db = createTestDb()
    invalidateKeyCountCache()
    state.corsEnabled = false
    state.corsAllowedOrigins = []
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    state.models = savedModels
    db.close()
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
    // May get non-401 (could be 200 or 502 depending on state)
    expect(res.status).not.toBe(401)
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

  test("/chat/completions with valid DB key → non-401", { timeout: 15_000 }, async () => {
    const created = createApiKey(db, "test-key")
    invalidateKeyCountCache()
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${created.key}` },
    })
    expect(res.status).not.toBe(401)
  })

  test("/embeddings without key → 401", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/embeddings", { method: "POST" })
    expect(res.status).toBe(401)
  })

  // -----------------------------------------------------------------------
  // Dashboard routes — dashboardAuth (dev mode for bootstrap)
  // -----------------------------------------------------------------------

  test("/api/* dev mode: no keys → open access", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/api/stats/overview")
    expect(res.status).toBe(200)
  })

  test("/api/* is auth-protected when apiKey is set", async () => {
    const app = createApp({ db, apiKey: "secret", internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/api/stats/overview")
    expect(res.status).toBe(401)
  })

  test("/api/* allows access with correct apiKey", async () => {
    const app = createApp({ db, apiKey: "secret", internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/api/stats/overview", {
      headers: { Authorization: "Bearer secret" },
    })
    expect(res.status).toBe(200)
  })

  test("/api/* allows access with RAVEN_INTERNAL_KEY", async () => {
    const app = createApp({ db, apiKey: null, internalKey: "internal", githubToken: "gh-test", port: null, baseUrl: null })
    const res = await app.request("/api/stats/overview", {
      headers: { Authorization: "Bearer internal" },
    })
    expect(res.status).toBe(200)
  })

  test("/api/* dev mode persists with DB keys (no env keys)", async () => {
    const key = createApiKey(db, "test-key")
    invalidateKeyCountCache()
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })

    // Without auth → 200 (dev mode: no env keys configured)
    const res1 = await app.request("/api/stats/overview")
    expect(res1.status).toBe(200)

    // With DB key → also 200
    const res2 = await app.request("/api/stats/overview", {
      headers: { Authorization: `Bearer ${key.key}` },
    })
    expect(res2.status).toBe(200)
  })

  test("dashboard stats endpoints are mounted at /api/stats/*", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: null, baseUrl: null })

    const endpoints = [
      "/api/stats/overview",
      "/api/stats/models",
      "/api/stats/recent?limit=1",
    ]

    for (const path of endpoints) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
    }
  })

  test("connection-info endpoint returns correct structure", async () => {
    const app = createApp({ db, apiKey: null, internalKey: null, githubToken: "gh-test", port: 7024, baseUrl: null })
    const res = await app.request("/api/connection-info")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.endpoints).toBeDefined()
    expect(body.endpoints.chat_completions).toBe("/v1/chat/completions")
    expect(body.endpoints.messages).toBe("/v1/messages")
  })

  // -----------------------------------------------------------------------
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
