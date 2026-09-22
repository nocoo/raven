import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
const { proxyUrl } = vi.hoisted(() => ({ proxyUrl: vi.fn() }))
vi.mock("../../src/lib/socks5-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/socks5-bridge")>(), getProxyUrl: proxyUrl,
}))
import { createUpstreamsRoute } from "../../src/routes/upstreams"
import { createProvider } from "../../src/db/providers"
import { routingFixture } from "../db/routing-fixture"

let fixture: ReturnType<typeof routingFixture>
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  fixture = routingFixture()
  proxyUrl.mockReturnValue("http://proxy.fixture.invalid:1234")
  fetcher.mockReset().mockRejectedValue(new Error("Unconfigured mock transport"))
  vi.stubGlobal("fetch", fetcher)
})
afterEach(() => { fixture.close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function refresh(id: string) {
  return new Hono().route("/api", createUpstreamsRoute(fixture.db))
    .request(`/api/upstreams/${id}/models/refresh`, { method: "POST" })
}

describe("explicit catalog refresh transport boundaries", () => {
  test.each(["bearer", "x-api-key"] as const)("honors stored %s authentication and proxy in one fetch", async (style) => {
    const provider = createProvider(fixture.db, { name: "fixture", base_url: "https://provider.fixture.invalid/v1", format: "anthropic_messages", api_key: "synthetic-key", auth_style: style })
    fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: "Raw.Model" }] }))
    const response = await refresh(provider.id)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ models: [{ id: "Raw.Model" }], last_refresh_error: null })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0]).toBe("https://provider.fixture.invalid/v1/models")
    const init = fetcher.mock.calls[0]![1] as RequestInit & { proxy: string }
    expect(init.proxy).toBe("http://proxy.fixture.invalid:1234")
    const headers = new Headers(init.headers)
    expect(headers.get(style === "bearer" ? "authorization" : "x-api-key")).toBe(style === "bearer" ? "Bearer synthetic-key" : "synthetic-key")
    expect(headers.has(style === "bearer" ? "x-api-key" : "authorization")).toBe(false)
  })

  test.each(["opaque rejection", null])("sanitizes a non-Error transport failure %j", async (failure) => {
    const provider = createProvider(fixture.db, { name: "fixture", base_url: "https://provider.fixture.invalid", format: "chat_completions", api_key: "synthetic-key" })
    fetcher.mockRejectedValueOnce(failure)
    const response = await refresh(provider.id)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { type: "catalog_refresh_failed", message: "Model refresh failed. Check the saved endpoint and credentials." } })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  test("does not read an error body that could contain credentials", async () => {
    const provider = createProvider(fixture.db, { name: "fixture", base_url: "https://provider.fixture.invalid", format: "chat_completions", api_key: "synthetic-key" })
    const upstream = new Response("synthetic-key", { status: 503 })
    const read = vi.spyOn(upstream, "text").mockRejectedValue(new Error("body read failed"))
    fetcher.mockResolvedValueOnce(upstream)
    const response = await refresh(provider.id)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { type: "catalog_refresh_failed", message: "Model discovery returned HTTP 503" } })
    expect(read).not.toHaveBeenCalled()
  })
})
