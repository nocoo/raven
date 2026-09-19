import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
const { proxyUrl } = vi.hoisted(() => ({ proxyUrl: vi.fn() }))
vi.mock("../../src/lib/socks5-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/socks5-bridge")>(), getProxyUrl: proxyUrl,
}))
import { createUpstreamsRoute } from "../../src/routes/upstreams"
import { createProvider, initProviders } from "../../src/db/providers"
import { state } from "../../src/lib/state"

let db: Database
const fetcher = vi.fn()
const savedProviders = state.providers
beforeEach(() => {
  db = new Database(":memory:")
  initProviders(db)
  proxyUrl.mockReturnValue("http://proxy.fixture.invalid:1234")
  fetcher.mockReset().mockRejectedValue(new Error("Unconfigured mock transport"))
  vi.stubGlobal("fetch", fetcher)
})
afterEach(() => { db.close(); state.providers = savedProviders; vi.unstubAllGlobals() })

describe("provider health transport boundaries", () => {
  test.each(["bearer", "x-api-key"] as const)("honors stored %s authentication and configured proxy using only a mocked transport", async (style) => {
    const provider = createProvider(db, { name: "fixture", base_url: "https://provider.fixture.invalid", format: "anthropic", api_key: "synthetic-key", model_patterns: ["fixture"], auth_style: style })
    fetcher.mockResolvedValueOnce(Response.json({}))
    const response = await new Hono().route("/api", createUpstreamsRoute(db)).request(`/api/upstreams/${provider.id}/models`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ healthy: true, total: 0 })
    expect(fetcher).toHaveBeenCalledOnce()
    const init = fetcher.mock.calls[0]?.[1]
    expect(init.proxy).toBe("http://proxy.fixture.invalid:1234")
    const headers = new Headers(init.headers)
    expect(headers.get(style === "bearer" ? "authorization" : "x-api-key")).toBe(style === "bearer" ? "Bearer synthetic-key" : "synthetic-key")
  })

  test.each(["opaque rejection", null])("does not report health after a non-Error transport failure: %j", async (failure) => {
    const provider = createProvider(db, { name: "fixture", base_url: "https://provider.fixture.invalid", format: "openai", api_key: "synthetic-key", model_patterns: ["fixture"] })
    fetcher.mockRejectedValue(failure)
    const response = await new Hono().route("/api", createUpstreamsRoute(db)).request(`/api/upstreams/${provider.id}/models`)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ healthy: false, supports_models_endpoint: false })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  test("preserves failure status when reading an upstream error body also fails", async () => {
    const provider = createProvider(db, { name: "fixture", base_url: "https://provider.fixture.invalid", format: "openai", api_key: "synthetic-key", model_patterns: ["fixture"] })
    const upstream = new Response("unreadable", { status: 503 })
    vi.spyOn(upstream, "text").mockRejectedValue(new Error("body read failed"))
    fetcher.mockResolvedValueOnce(upstream)
    const response = await new Hono().route("/api", createUpstreamsRoute(db)).request(`/api/upstreams/${provider.id}/models`)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ healthy: false, error: { type: "upstream_error", message: "Upstream returned 503: " } })
  })
})
