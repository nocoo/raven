import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { COPILOT_RULE_ID } from "../../src/core/routing-types"
import { createApiKey, revokeApiKey } from "../../src/db/keys"
import { dashboardAuth } from "../../src/middleware"
import { getSentinelStatus } from "../../src/lib/token-sentinel"
import { createSentinelStatusRoute } from "../../src/routes/sentinel-status"
import { NOW, routingFixture } from "../db/routing-fixture"

let fixture: ReturnType<typeof routingFixture>
let app: Hono

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Sentinel status must not call upstreams"))
  fixture = routingFixture()
  app = new Hono()
  app.use("*", async (c, next) => { c.env = { remoteAddress: "::1" }; await next() })
  app.use("/api/*", dashboardAuth({ internalKey: "fixture-internal" }))
  app.route("/api", createSentinelStatusRoute())
})

afterEach(() => {
  fixture.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("GET /api/sentinel-status", () => {
  test("returns a structured snapshot with counters and live state", async () => {
    const res = await app.request("/api/sentinel-status", { headers: { "x-api-key": "fixture-internal" } })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    // Top-level live state
    expect(body).toHaveProperty("generation")
    expect(body).toHaveProperty("mode")
    expect(body).toHaveProperty("cooldownRemainingMs")
    expect(body).toHaveProperty("consecutiveFailures")
    expect(body).toHaveProperty("forceSteadyAfterCooldown")
    expect(body).toHaveProperty("lastRefreshInSeconds")
    expect(body).toHaveProperty("lastSuccessAt")
    expect(body).toHaveProperty("hasInflight")
    expect(body).toHaveProperty("pendingTimer")
    expect(body).toHaveProperty("signalScore")

    // Counters
    const counters = body.counters as Record<string, unknown>
    expect(counters).toBeDefined()
    expect(counters).toHaveProperty("refreshRequested")
    expect(counters).toHaveProperty("refreshUpstreamCalls")
    expect(counters).toHaveProperty("refreshSucceededTokenUpdated")
    expect(counters).toHaveProperty("refreshSucceededTokenUpdatedByReason")
    expect(counters).toHaveProperty("refreshFailed")
    expect(counters).toHaveProperty("refreshFailedByReason")
    expect(counters).toHaveProperty("refreshBlockedByCooldownByReason")
    expect(counters).toHaveProperty("refreshShortCircuitByReason")
    expect(counters).toHaveProperty("llm401TokenExpired")
    expect(counters).toHaveProperty("llm401Other")
    expect(counters).toHaveProperty("cacheModels401")
    expect(counters).toHaveProperty("probingEntered")

    const requested = counters.refreshRequested as Record<string, unknown>
    expect(requested).toEqual(
      expect.objectContaining({
        llm401: expect.any(Number),
        sentinel401: expect.any(Number),
        scheduled: expect.any(Number),
        manual: expect.any(Number),
      }),
    )

    const successByReason = counters.refreshSucceededTokenUpdatedByReason as Record<string, unknown>
    expect(successByReason).toEqual(
      expect.objectContaining({
        llm401: expect.any(Number),
        sentinel401: expect.any(Number),
        scheduled: expect.any(Number),
        manual: expect.any(Number),
      }),
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("requires management authentication and rejects a revoked bound key", async () => {
    const key = createApiKey(fixture.db, "Monitor", COPILOT_RULE_ID)
    expect((await app.request("/api/sentinel-status")).status).toBe(401)
    expect((await app.request("/api/sentinel-status", { headers: { "x-api-key": "invalid" } })).status).toBe(401)
    revokeApiKey(fixture.db, key.id)
    expect((await app.request("/api/sentinel-status", { headers: { "x-api-key": key.key } })).status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("the internal key reads the same snapshot without starting refreshes or timers", async () => {
    const snapshot = getSentinelStatus()
    const timeout = vi.spyOn(globalThis, "setTimeout")
    const interval = vi.spyOn(globalThis, "setInterval")
    const response = await app.request("/api/sentinel-status", { headers: { Authorization: "Bearer fixture-internal" } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(snapshot)
    expect(getSentinelStatus()).toEqual(snapshot)
    expect(timeout).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
