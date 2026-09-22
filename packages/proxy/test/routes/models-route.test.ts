import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { routingHarness } from "../helpers/routing"
import { replaceCatalog } from "../../src/db/catalog"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"

let h: ReturnType<typeof routingHarness>
beforeEach(() => { h = routingHarness(); vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call")) })
afterEach(() => { h.close(); vi.restoreAllMocks() })

test("authenticated model reads project every cache, deduplicate and protect virtual auto", async () => {
  h.copilot([{ id: "same", owned_by: "copilot", supported_endpoints: ["/responses"] }, { id: "auto", owned_by: "upstream" }])
  const upstream = h.upstream({ manual_models: ["Manual-ID", "same"] })
  replaceCatalog(h.db, upstream.id, [{ id: "same", owned_by: "custom" }, { id: "custom" }])
  const result = await (await h.request("/v1/models?refresh=true")).json() as { data: { id: string; owned_by?: string }[] }
  expect(result.data.map((m) => m.id)).toEqual(["auto", "same", "custom", "Manual-ID"])
  expect(result.data[0]).toEqual({ id: "auto", object: "model", owned_by: "raven" })
  expect(result.data[1]?.owned_by).toBe("copilot")
  expect(fetch).not.toHaveBeenCalled()
})

test("catalog reads authenticate before touching storage", async () => {
  expect((await h.request("/v1/models", undefined, "GET", "wrong-key")).status).toBe(401)
  expect((await h.request("/v1/models", undefined, "GET", "fixture-internal")).status).toBe(401)
  expect(fetch).not.toHaveBeenCalled()
})

test("catalog storage errors produce one failure log without fetching", async () => {
  const events: LogEvent[] = []
  const listener = (event: LogEvent) => events.push(event)
  logEmitter.on("log", listener)
  try {
    h.db.exec("DROP TABLE providers")
    expect((await h.request("/v1/models")).status).toBe(500)
    expect(events.filter((event) => event.type === "request_end")).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  } finally { logEmitter.off("log", listener) }
})
