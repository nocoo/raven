import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { state } from "../../src/lib/state"
import { getQuotaStatus } from "../../src/db/quota"
import { updateProvider } from "../../src/db/providers"
import { startRequestSink } from "../../src/db/request-sink"
import { queryRequests } from "../../src/db/requests"
import { quotaPolicy, NOW, HOUR } from "../db/routing-fixture"
import { chatResponse, jsonResponse, routingHarness } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
let network: ReturnType<typeof vi.spyOn>
let clock: ReturnType<typeof vi.spyOn>
let saved: typeof state
const body = { model: "auto", messages: [{ role: "user", content: "ping" }] }
beforeEach(() => {
  clock = vi.spyOn(Date, "now").mockReturnValue(NOW)
  h = routingHarness(); saved = { ...state }; state.rateLimitSeconds = null
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"))
})
afterEach(() => { h.close(); Object.assign(state, saved); vi.restoreAllMocks() })

test("only quota exhaustion moves to the next target and the first recovers after reset", async () => {
  const first = h.upstream({ name: "First", base_url: "https://first.invalid/v1", quota: quotaPolicy({ limit_tokens: 10 }) })
  const fallback = h.upstream({ name: "Terminal", base_url: "https://terminal.invalid/v1" })
  h.bind(first.id, "first-model", { default_chain: [{ upstream_id: first.id, model: "first-model" }, { upstream_id: fallback.id, model: "terminal-model" }] })
  network.mockImplementation(async (_url: unknown, init: RequestInit) => jsonResponse(chatResponse(JSON.parse(init.body as string).model)))
  const stop = startRequestSink(h.db)
  try {
    expect((await h.request("/v1/chat/completions", body)).status).toBe(200)
    expect((await h.request("/v1/chat/completions", { ...body, model: "XYZ.Raw" })).status).toBe(200)
    expect(network.mock.calls[1]?.[0]).toContain("terminal.invalid")
    expect(JSON.parse(network.mock.calls[1]![1].body).model).toBe("XYZ.Raw")
    const requests = queryRequests(h.db).data
    expect(requests.some((row) => row.routing?.skipped.some((skip) => skip.upstream_id === first.id))).toBe(true)
    clock.mockReturnValue(NOW + HOUR)
    expect((await h.request("/v1/chat/completions", body)).status).toBe(200)
    expect(network.mock.calls[2]?.[0]).toContain("first.invalid")
    expect(getQuotaStatus(h.db, first.id, NOW + HOUR).used_tokens).toBe(12)
  } finally { stop() }
})

test.each([400, 401, 404, 429, 500, 503])("HTTP %s on an eligible upstream is final", async (status) => {
  const first = h.upstream()
  const next = h.upstream({ base_url: "https://must-not-call.invalid/v1" })
  h.bind(first.id, "first", { default_chain: [{ upstream_id: first.id, model: "first" }, { upstream_id: next.id, model: "last" }] })
  network.mockResolvedValueOnce(jsonResponse({ error: "fixture failure" }, status))
  expect((await h.request("/v1/chat/completions", body)).status).toBe(status)
  expect(network).toHaveBeenCalledTimes(1)
})

test("disabled and mismatched eligible targets do not fall through", async () => {
  const first = h.upstream({ is_enabled: false })
  const last = h.upstream()
  h.bind(first.id, "first", { default_chain: [{ upstream_id: first.id, model: "first" }, { upstream_id: last.id, model: "last" }], allow_conversion: false })
  expect((await h.request("/v1/chat/completions", body)).status).toBe(503)
  updateProvider(h.db, first.id, { is_enabled: true, format: "anthropic_messages" })
  expect((await h.request("/v1/chat/completions", body)).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})

test("a reached accounting failure blocks selection without altering a completed generation", async () => {
  const first = h.upstream({ quota: quotaPolicy() })
  const last = h.upstream()
  h.bind(first.id, "first", { default_chain: [{ upstream_id: first.id, model: "first" }, { upstream_id: last.id, model: "last" }] })
  h.db.exec("CREATE TRIGGER fixture_accounting_failure BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'fixture ledger unavailable'); END")
  network.mockImplementation(async () => jsonResponse(chatResponse("first")))
  const stop = startRequestSink(h.db)
  try {
    expect((await h.request("/v1/chat/completions", body)).status).toBe(200)
    expect(queryRequests(h.db).data[0]?.routing).toMatchObject({ accounting_healthy: false })
    expect((await h.request("/v1/chat/completions", body)).status).toBe(503)
    expect(network).toHaveBeenCalledTimes(1)
    updateProvider(h.db, first.id, { quota: null })
    expect((await h.request("/v1/chat/completions", body)).status).toBe(200)
    expect(network).toHaveBeenCalledTimes(2)
    h.db.exec("DROP TRIGGER fixture_accounting_failure")
    expect((await h.request("/v1/chat/completions", body)).status).toBe(200)
    expect(h.db.query("SELECT COUNT(*) AS n FROM quota_settlements").get()).toEqual({ n: 3 })
  } finally { stop() }
})

test("time, window, multiplier and target stay locked during an SSE generation", async () => {
  const up = h.upstream({ quota: quotaPolicy({ mode: "daily", multipliers: [{ id: "peak", start_minute: 0, end_minute: 60, multiplier: 2 }] }) })
  const next = h.upstream({ base_url: "https://later.invalid/v1" })
  h.bind(up.id, "admitted-model", { mode: "daily", periods: [{ id: "first-hour", start_minute: 0, end_minute: 60, targets: [{ upstream_id: up.id, model: "admitted-model" }] }], default_chain: [{ upstream_id: next.id, model: "later-model" }] })
  const window = getQuotaStatus(h.db, up.id, NOW).window_id
  let stream!: ReadableStreamDefaultController<Uint8Array>
  network.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { "Content-Type": "text/event-stream" } }))
  const response = await h.request("/v1/chat/completions", { ...body, stream: true })
  clock.mockReturnValue(NOW + 2 * HOUR)
  expect(getQuotaStatus(h.db, up.id, NOW + 2 * HOUR).window_id).not.toBe(window)
  const chunk = { id: "chat-fixture", model: "admitted-model", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: "stop" }], usage: chatResponse().usage }
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)); stream.close()
  expect(await response.text()).toContain("admitted-model")
  expect(getQuotaStatus(h.db, up.id, NOW + 2 * HOUR).used_tokens).toBe(0)
  expect(h.db.query("SELECT charged FROM quota_windows WHERE id = ?").get(window)).toEqual({ charged: 24 })
  expect(network).toHaveBeenCalledTimes(1)
})
