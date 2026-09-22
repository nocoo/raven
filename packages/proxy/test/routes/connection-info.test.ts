import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { createConnectionInfoRoute } from "../../src/routes/connection-info"
import { replaceCatalog } from "../../src/db/catalog"
import { routingHarness } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
beforeEach(() => { h = routingHarness(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call")) })
afterEach(() => { h.close(); vi.restoreAllMocks() })

test("connection info uses only cached raw IDs and includes Responses", async () => {
  h.copilot([{ id: "shared", vendor: "copilot" }])
  const upstream = h.upstream({ manual_models: ["manual", "shared"], is_enabled: false })
  replaceCatalog(h.db, upstream.id, [{ id: "fetched" }])
  const result = await (await h.request("/api/connection-info")).json() as { models: string[]; endpoints: Record<string, string> }
  expect(result.models).toEqual(["auto", "shared", "fetched", "manual"])
  expect(result.endpoints.responses).toBe("/v1/responses")
  expect(fetch).not.toHaveBeenCalled()
})

test.each([null, "https://proxy.example.test"])("connection info builds the configured base URL %s", async (baseUrl) => {
  const app = new Hono()
  app.route("/api", createConnectionInfoRoute({ db: h.db, port: 9876, baseUrl }))
  expect(await (await app.request("/api/connection-info")).json()).toMatchObject({ base_url: baseUrl ?? "http://localhost:9876", models: ["auto"] })
  expect(fetch).not.toHaveBeenCalled()
})
