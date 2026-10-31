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

test("model reads expose Copilot metadata using Magpie fields without fabricating unknown values", async () => {
  h.copilot([
    { id: "known", name: "Known model", vendor: "GitHub", context_length: 1, capabilities: { type: "chat",
      limits: { max_context_window_tokens: 1050000, max_prompt_tokens: 922000, max_output_tokens: 128000 },
      supports: { tool_calls: true, vision: true, reasoning_effort: ["none", "high"] },
    } },
    { id: "disabled", capabilities: { supports: { tool_calls: false, reasoning_effort: [] } } },
    { id: "partial", capabilities: { limits: { max_context_window_tokens: 400000, max_prompt_tokens: null, max_output_tokens: 0 }, supports: { tool_calls: null, reasoning_effort: ["high", null] } } },
    { id: "invalid", name: " ", capabilities: { limits: { max_context_window_tokens: -1, max_prompt_tokens: 1.5, max_output_tokens: "128000" }, supports: { reasoning_effort: [""] } } },
    { id: "unknown", capabilities: null },
  ])
  const upstream = h.upstream()
  replaceCatalog(h.db, upstream.id, [{ id: "custom", name: "Custom", capabilities: { limits: { max_context_window_tokens: 100 } } }])

  const result = await (await h.request("/v1/models")).json() as { object: string; data: Record<string, unknown>[]; first_id: string; last_id: string; has_more: boolean }
  expect(result).toMatchObject({ object: "list", first_id: "auto", last_id: "custom", has_more: false })
  expect(result.data[0]).toEqual({ id: "auto", object: "model", owned_by: "raven" })
  expect(result.data[1]).toMatchObject({
    id: "known", display_name: "Known model", context_length: 1050000, context_window: 1050000,
    max_input_tokens: 922000, max_output_tokens: 128000, tool_call: true, reasoning: true,
    reasoning_levels: ["none", "high"], supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }], modalities: { input: ["text", "image"] },
  })
  expect(result.data[2]).toMatchObject({ tool_call: false, reasoning: false, reasoning_levels: [], supported_reasoning_levels: [] })
  expect(result.data[3]).toMatchObject({ context_length: 400000, context_window: 400000 })
  for (const model of result.data.slice(3, 6)) {
    expect(model).not.toHaveProperty("max_input_tokens")
    expect(model).not.toHaveProperty("max_output_tokens")
    expect(model).not.toHaveProperty("reasoning")
    expect(model).not.toHaveProperty("tool_call")
    expect(model).not.toHaveProperty("modalities")
  }
  expect(result.data[4]).not.toHaveProperty("context_length")
  expect(result.data[4]).not.toHaveProperty("display_name")
  expect(result.data[5]).not.toHaveProperty("context_length")
  expect(result.data[6]).not.toHaveProperty("context_length")
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
