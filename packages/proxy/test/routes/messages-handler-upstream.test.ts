import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { state } from "../../src/lib/state"
import { getQuotaStatus } from "../../src/db/quota"
import { updateProvider } from "../../src/db/providers"
import * as tavily from "../../src/lib/server-tools/tavily"
import { COPILOT_UPSTREAM_ID, type UpstreamFormat } from "../../src/core/routing-types"
import type { ClientProtocol } from "../../src/core/router"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { quotaPolicy, NOW, HOUR } from "../db/routing-fixture"
import { chatResponse, messageResponse, responsesResponse, generationEvents, jsonResponse, sseResponse, routingHarness } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
let network: ReturnType<typeof vi.spyOn>
let saved: typeof state
const sources = ["anthropic", "openai", "responses"] as const
const targets = ["anthropic_messages", "chat_completions", "responses"] as const
const paths = { anthropic: "/v1/messages", openai: "/v1/chat/completions", responses: "/v1/responses" }
const outputProtocols = { anthropic_messages: "anthropic", chat_completions: "openai", responses: "responses" } as const
const replies = { anthropic: messageResponse, openai: chatResponse, responses: responsesResponse }

function payload(source: ClientProtocol, model = "auto", stream = false) {
  return source === "responses" ? { model, input: "ping", stream }
    : { model, messages: [{ role: "user", content: "ping" }], ...(source === "anthropic" ? { max_tokens: 32 } : {}), stream }
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  h = routingHarness(); saved = { ...state }
  state.copilotToken = "fixture-token"; state.rateLimitSeconds = null
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"))
})
afterEach(() => { h.close(); Object.assign(state, saved); vi.restoreAllMocks() })

const matrix = sources.flatMap((source) => targets.flatMap((target) => [false, true].map((stream) => ({ source, target, stream }))))
test.each(matrix)("$source to $target, stream=$stream resolves auto before protocol execution and charges once", async ({ source, target, stream }) => {
  const up = h.upstream({ format: target, quota: quotaPolicy() })
  h.bind(up.id, "Chosen.Raw-ID")
  const protocol = outputProtocols[target]
  network.mockResolvedValueOnce(stream ? sseResponse(generationEvents(protocol, "Chosen.Raw-ID"), protocol) : jsonResponse(replies[protocol]("Chosen.Raw-ID")))
  const response = await h.request(paths[source], payload(source, "auto", stream))
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).toContain("pong")
  expect(text).toContain("Chosen.Raw-ID")
  expect(text).not.toContain('"model":"auto"')
  if (stream) expect(text).toContain(source === "anthropic" ? "message_stop" : source === "openai" ? "[DONE]" : "response.completed")
  else expect(JSON.parse(text)).toMatchObject(source === "anthropic" ? { type: "message" } : { object: source === "openai" ? "chat.completion" : "response" })
  expect(network).toHaveBeenCalledTimes(1)
  const sent = JSON.parse(network.mock.calls[0]![1].body)
  expect(sent.model).toBe("Chosen.Raw-ID")
  expect(getQuotaStatus(h.db, up.id, NOW).used_tokens).toBe(12)
  expect(h.db.query("SELECT COUNT(*) AS n FROM quota_settlements").get()).toEqual({ n: 1 })
})

test.each(sources.flatMap(source => [false, true].map(stream => ({ source, stream }))))("the migrated Copilot auto model works through $source with Responses-only capabilities, stream=$stream", async ({ source, stream }) => {
  h.copilot([{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }])
  network.mockResolvedValueOnce(stream ? sseResponse(generationEvents("responses", "gpt-5.6-sol"), "responses") : jsonResponse(responsesResponse("gpt-5.6-sol")))
  const events: LogEvent[] = []
  const listener = (event: LogEvent) => events.push(event)
  logEmitter.on("log", listener)
  try {
    const response = await h.request(paths[source], payload(source, "auto", stream))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("pong")
    expect(network).toHaveBeenCalledOnce()
    expect(network.mock.calls[0]?.[0]).toContain("/responses")
    expect(JSON.parse(network.mock.calls[0]![1].body).model).toBe("gpt-5.6-sol")
    expect(events.filter((event) => event.type === "request_end")).toHaveLength(1)
    expect(events.find((event) => event.type === "request_end")?.data).toMatchObject({ model: "auto", resolvedModel: "gpt-5.6-sol", upstreamId: COPILOT_UPSTREAM_ID })
  } finally { logEmitter.off("log", listener) }
})

test.each(sources.flatMap((source, i) => targets.filter((_, j) => j !== i).map((target) => ({ source, target }))))(
  "conversion OFF rejects $source to $target before any HTTP call", async ({ source, target }) => {
    const up = h.upstream({ format: target })
    h.bind(up.id, "target", { allow_conversion: false })
    const result = await h.request(paths[source], payload(source))
    expect(result.status).toBe(400)
    expect(await result.json()).toMatchObject({ error: { type: "protocol_mismatch" }, ...(source === "anthropic" ? { type: "error" } : {}) })
    expect(network).not.toHaveBeenCalled()
  },
)

test("Copilot Messages to Responses applies the established block sanitizer before conversion validation", async () => {
  h.copilot([{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }])
  network.mockResolvedValueOnce(jsonResponse(responsesResponse("gpt-5.6-sol")))
  const response = await h.request("/v1/messages", {
    model: "auto", max_tokens: 32,
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }, { type: "redacted_thinking", data: "opaque-redacted-block" }] }],
  })
  expect(response.status).toBe(200)
  expect(network).toHaveBeenCalledOnce()
  expect(String(network.mock.calls[0]![1].body)).not.toContain("opaque-redacted-block")
  expect(String(network.mock.calls[0]![1].body)).toContain("ping")
})

test("server-tool model rounds retain the admitted target and quota window across a reset and rule edit", async () => {
  state.stWebSearchEnabled = true
  state.stWebSearchApiKey = "fixture-search"
  h.copilot([{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }])
  updateProvider(h.db, COPILOT_UPSTREAM_ID, { quota: quotaPolicy({ mode: "daily", multipliers: [{ id: "peak", start_minute: 0, end_minute: 1440, multiplier: 2 }] }) })
  const captured = getQuotaStatus(h.db, COPILOT_UPSTREAM_ID, NOW)
  const replacement = h.upstream()
  const search = vi.spyOn(tavily, "searchTavily").mockImplementationOnce(async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW + 6 * HOUR)
    h.bind(replacement.id, "changed-after-admission")
    getQuotaStatus(h.db, COPILOT_UPSTREAM_ID, NOW + 6 * HOUR)
    return { type: "web_search_tool_result", content: [], textContent: "Fixture search result" }
  })
  network.mockResolvedValueOnce(jsonResponse({
    ...responsesResponse("gpt-5.6-sol"),
    output: [{ type: "function_call", id: "fc-1", call_id: "tool-1", name: "web_search", arguments: '{"query":"fixture"}', status: "completed" }],
  })).mockResolvedValueOnce(jsonResponse(responsesResponse("gpt-5.6-sol")))
  const response = await h.request("/v1/messages", {
    model: "auto", max_tokens: 32, messages: [{ role: "user", content: "Search fixture docs" }],
    tools: [
      { name: "web_search", type: "web_search_20250305", input_schema: { type: "object" } },
      { name: "get_weather", description: "Read the weather", input_schema: { type: "object", properties: {} } },
    ],
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("pong")
  expect(search).toHaveBeenCalledOnce()
  expect(network).toHaveBeenCalledTimes(2)
  for (const [url, init] of network.mock.calls) {
    expect(String(url)).toBe("https://api.githubcopilot.com/responses")
    expect(JSON.parse(String(init?.body)).model).toBe("gpt-5.6-sol")
  }
  expect(h.db.query("SELECT attempt_ordinal, upstream_id, window_id, captured_at, multiplier, weighted_debit FROM quota_settlements ORDER BY attempt_ordinal").all()).toEqual([0, 1].map(attempt_ordinal => ({ attempt_ordinal, upstream_id: COPILOT_UPSTREAM_ID, window_id: captured.window_id, captured_at: NOW, multiplier: 2, weighted_debit: 24 })))
  expect(h.db.query("SELECT charged FROM quota_windows WHERE id = ?").get(captured.window_id)).toEqual({ charged: 48 })
  expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID, NOW + 6 * HOUR).used_tokens).toBe(0)
})

test.each(sources)("explicit raw model on %s never switches providers based on catalogs", async (source) => {
  const up = h.upstream({ format: "chat_completions", manual_models: ["configured-model"] })
  h.bind(up.id, "configured-model")
  const explicit = "claude-sonnet-4-20250514"
  network.mockResolvedValueOnce(jsonResponse(chatResponse(explicit)))
  const response = await h.request(paths[source], payload(source, explicit))
  expect(response.status).toBe(200)
  expect(JSON.parse(network.mock.calls[0]![1].body).model).toBe(explicit)
  expect(network.mock.calls[0]?.[0]).toContain("upstream.invalid")
})

test("Responses passthrough preserves native state and sampling fields", async () => {
  const up = h.upstream({ format: "responses" })
  h.bind(up.id)
  const body = { model: "explicit", input: "ping", previous_response_id: "opaque-id", temperature: 0.37, max_output_tokens: 65 }
  network.mockResolvedValueOnce(jsonResponse(responsesResponse("explicit")))
  expect((await h.request("/v1/responses", body)).status).toBe(200)
  expect(JSON.parse(network.mock.calls[0]![1].body)).toEqual(body)
})

test.each(["anthropic_messages", "chat_completions"] as UpstreamFormat[])("Responses state cannot be silently lost when converting to %s", async (format) => {
  const up = h.upstream({ format })
  h.bind(up.id)
  expect((await h.request("/v1/responses", { model: "auto", input: "ping", previous_response_id: "opaque" })).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})
