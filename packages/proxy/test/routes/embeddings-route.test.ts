import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_UPSTREAM_ID } from "../../src/core/routing-types"
import { updateProvider } from "../../src/db/providers"
import { getQuotaStatus } from "../../src/db/quota"
import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { NOW, quotaPolicy } from "../db/routing-fixture"
import { jsonResponse, routingHarness } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
let saved: typeof state
let events: LogEvent[]
const listen = (event: LogEvent) => events.push(event)
const fetcher = vi.fn<typeof fetch>()
const embedding = { object: "list", data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }], model: "embedding-model", usage: { prompt_tokens: 5, total_tokens: 5 } }
beforeEach(() => {
  h = routingHarness()
  saved = { ...state }
  state.copilotToken = "fixture-token"
  events = []
  logEmitter.on("log", listen)
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  fetcher.mockReset().mockResolvedValue(jsonResponse(embedding))
  vi.stubGlobal("fetch", fetcher)
})
afterEach(() => {
  logEmitter.off("log", listen)
  Object.assign(state, saved)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  h.close()
})

describe("key-bound embeddings", () => {
  test("an explicit uncached model uses native Copilot and settles input-only usage", async () => {
    updateProvider(h.db, COPILOT_UPSTREAM_ID, { quota: quotaPolicy() })
    const response = await h.request("/v1/embeddings", { model: "Unknown.Raw-ID", input: "hello", dimensions: 2 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(embedding)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/embeddings$/)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ model: "Unknown.Raw-ID", dimensions: 2 })
    expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID, NOW).used_tokens).toBe(5)
    expect(events.filter((event) => event.type === "request_end")).toHaveLength(1)
    expect(events.at(-1)!.data).toMatchObject({ routing: { requested_model: "Unknown.Raw-ID", weighted_tokens: 5, usage_complete: true } })
  })

  test.each([
    { supported_endpoints: ["/embeddings"] }, { supported_endpoints: ["/v1/embeddings"] },
    { capabilities: { type: "embedding" } }, { capabilities: { type: "embeddings" } },
  ])("auto requires and accepts positive capabilities %j", async (metadata) => {
    h.copilot([{ id: "embedding-model", ...metadata }])
    h.bind(COPILOT_UPSTREAM_ID, "embedding-model")
    expect((await h.request("/v1/embeddings", { model: "auto", input: ["hello"] })).status).toBe(200)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).model).toBe("embedding-model")
  })

  test.each([
    { metadata: {}, status: 503 }, { metadata: { capabilities: { type: "chat" } }, status: 400 },
    { metadata: { capabilities: { type: "completion" } }, status: 400 },
    { metadata: { supported_endpoints: ["/responses"] }, status: 400 },
  ])("auto does not guess for $metadata", async ({ metadata, status }) => {
    h.copilot([{ id: "chosen", ...metadata }])
    h.bind(COPILOT_UPSTREAM_ID, "chosen")
    expect((await h.request("/v1/embeddings", { model: "auto", input: "hello" })).status).toBe(status)
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("custom upstream selection and exhausted quota cannot bypass the rule", async () => {
    h.bind(h.upstream().id)
    expect((await h.request("/v1/embeddings", { model: "explicit", input: "hello" })).status).toBe(400)
    h.bind(COPILOT_UPSTREAM_ID)
    updateProvider(h.db, COPILOT_UPSTREAM_ID, { quota: quotaPolicy() })
    h.db.query("UPDATE quota_windows SET charged = 100 WHERE upstream_id = ?").run(COPILOT_UPSTREAM_ID)
    expect((await h.request("/v1/embeddings", { model: "explicit", input: "hello" })).status).toBe(429)
    expect(fetcher).not.toHaveBeenCalled()
  })

  test.each(["{", "null", "{}", '{"model":" "}'])("rejects invalid input %s without network", async (body) => {
    const response = await h.app.request("/v1/embeddings", { method: "POST", headers: { authorization: "Bearer fixture-client", "content-type": "application/json" }, body })
    expect(response.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
    expect(events.filter((event) => event.type === "request_end")).toHaveLength(1)
  })

  test("preserves a dispatch failure and logs once", async () => {
    fetcher.mockRejectedValueOnce(new Error("upstream failed"))
    expect((await h.request("/v1/embeddings", { model: "explicit", input: "hello" })).status).toBe(500)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === "request_end")).toHaveLength(1)
  })
})
