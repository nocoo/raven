import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createApp } from "../src/app.ts"
import { initDatabase } from "../src/db/requests.ts"
import { initApiKeys, createApiKey } from "../src/db/keys.ts"
import { invalidateKeyCountCache } from "../src/middleware.ts"

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

  beforeEach(() => {
    db = createTestDb()
    invalidateKeyCountCache()
  })

  afterEach(() => {
    db.close()
  })

  test("returns a Hono app", () => {
    const app = createApp({ db, githubToken: "gh-test" })
    expect(app).toBeDefined()
    expect(typeof app.fetch).toBe("function")
  })

  test("GET /health returns 200", async () => {
    const app = createApp({ db, githubToken: "gh-test" })
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: "ok" })
  })

  test("health endpoint is NOT auth-protected", async () => {
    const app = createApp({ db, apiKey: "secret", githubToken: "gh-test" })
    const res = await app.request("/health")
    expect(res.status).toBe(200)
  })

  // -----------------------------------------------------------------------
  // AI routes — apiKeyAuth (strict, no dev mode)
  // -----------------------------------------------------------------------

  test("/v1/* returns 401 when no keys configured (no dev mode)", async () => {
    const app = createApp({ db, githubToken: "gh-test" })
    const res = await app.request("/v1/models")
    expect(res.status).toBe(401)
  })

  test("/v1/* is auth-protected when apiKey is set", async () => {
    const app = createApp({ db, apiKey: "secret", githubToken: "gh-test" })
    const res = await app.request("/v1/models")
    expect(res.status).toBe(401)
  })

  test("/v1/* allows access with correct apiKey", async () => {
    const app = createApp({ db, apiKey: "secret", githubToken: "gh-test" })
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer secret" },
    })
    // May get non-401 (could be 200 or 502 depending on state)
    expect(res.status).not.toBe(401)
  })

  test("/v1/* rejects RAVEN_INTERNAL_KEY", async () => {
    const app = createApp({ db, apiKey: "secret", internalKey: "internal", githubToken: "gh-test" })
    const res = await app.request("/v1/models", {
      headers: { Authorization: "Bearer internal" },
    })
    expect(res.status).toBe(401)
  })

  // -----------------------------------------------------------------------
  // Aliases — same auth as /v1/* routes
  // -----------------------------------------------------------------------

  test("/chat/completions without key → 401", async () => {
    const app = createApp({ db, githubToken: "gh-test" })
    const res = await app.request("/chat/completions", { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("/chat/completions with valid DB key → non-401", async () => {
    const created = createApiKey(db, "test-key")
    invalidateKeyCountCache()
    const app = createApp({ db, githubToken: "gh-test" })
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${created.key}` },
    })
    expect(res.status).not.toBe(401)
  })

  test("/embeddings without key → 401", async () => {
    const app = createApp({ db, githubToken: "gh-test" })
    const res = await app.request("/embeddings", { method: "POST" })
    expect(res.status).toBe(401)
  })

  // -----------------------------------------------------------------------
  // Dashboard routes — dashboardAuth (dev mode for bootstrap)
  // -----------------------------------------------------------------------

  test("/api/* dev mode: no keys → open access", async () => {
    const app = createApp({ db, githubToken: "gh-test" })
    const res = await app.request("/api/stats/overview")
    expect(res.status).toBe(200)
  })

  test("/api/* is auth-protected when apiKey is set", async () => {
    const app = createApp({ db, apiKey: "secret", githubToken: "gh-test" })
    const res = await app.request("/api/stats/overview")
    expect(res.status).toBe(401)
  })

  test("/api/* allows access with correct apiKey", async () => {
    const app = createApp({ db, apiKey: "secret", githubToken: "gh-test" })
    const res = await app.request("/api/stats/overview", {
      headers: { Authorization: "Bearer secret" },
    })
    expect(res.status).toBe(200)
  })

  test("/api/* allows access with RAVEN_INTERNAL_KEY", async () => {
    const app = createApp({ db, internalKey: "internal", githubToken: "gh-test" })
    const res = await app.request("/api/stats/overview", {
      headers: { Authorization: "Bearer internal" },
    })
    expect(res.status).toBe(200)
  })

  test("/api/* dev mode persists with DB keys (no env keys)", async () => {
    const key = createApiKey(db, "test-key")
    invalidateKeyCountCache()
    const app = createApp({ db, githubToken: "gh-test" })

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
    const app = createApp({ db, githubToken: "gh-test" })

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
    const app = createApp({ db, githubToken: "gh-test", port: 7033 })
    const res = await app.request("/api/connection-info")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.endpoints).toBeDefined()
    expect(body.endpoints.chat_completions).toBe("/v1/chat/completions")
    expect(body.endpoints.messages).toBe("/v1/messages")
  })
})
