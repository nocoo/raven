import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createApp } from "../../src/app"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../../src/core/routing-types"
import { createApiKey, revokeApiKey } from "../../src/db/keys"
import { createRoutingRule } from "../../src/db/routing-rules"
import { saveQuotaPolicy, getQuotaStatus } from "../../src/db/quota"
import { writeIPPolicy } from "../../src/db/ip-policy"
import { startRequestSink } from "../../src/db/request-sink"
import { state } from "../../src/lib/state"
import { parseRules } from "../../src/lib/ip-access"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { quotaPolicy, ruleInput } from "../db/routing-fixture"
import { jsonResponse, routingHarness } from "../helpers/routing"

const model = "microsoft-decision-1"
const payload = { model, state: "A small code change has not been tested.", questions: {
  next_step: { type: "choice", instructions: "Choose the next step.", criteria: { test: "Run tests", merge: "Merge" } },
} }
const body = '{"answers":{"next_step":{"type":"choice","choice":"test","probabilities":{"test":0.9999999999999999999,"merge":1e-19}}},"usage":{"input_tokens":45,"output_tokens":1},"extension":true}\n'
let h: ReturnType<typeof routingHarness>
let network: ReturnType<typeof vi.spyOn>
let saved: typeof state
let events: LogEvent[]
let stop: () => void
const listener = (event: LogEvent) => events.push(event)

beforeEach(() => {
  h = routingHarness()
  saved = { ...state }
  Object.assign(state, { copilotToken: "fixture-copilot-token", copilotApiBaseUrl: "https://api.enterprise.githubcopilot.com", githubToken: "fixture-github-token", rateLimitSeconds: null, socks5Enabled: false, ipWhitelistEnabled: false })
  h.copilot([{ id: model, capabilities: { type: "decisions" }, supported_endpoints: ["/v1/systemone"] }])
  events = []
  logEmitter.on("log", listener)
  stop = startRequestSink(h.db)
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream call"))
})
afterEach(() => {
  stop()
  logEmitter.off("log", listener)
  h.close()
  Object.assign(state, saved)
  vi.restoreAllMocks()
})

test("the unified key sends one native request and preserves raw response numbers and absent fields", async () => {
  network.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "application/json", "set-cookie": "private", authorization: "private" } }))
  const request = { ...payload, extra: { keep: [null, true] }, questions: { ...payload.questions,
    gate: { type: "noul", instructions: null }, score: { type: "score", criteria: ["bad", "good"] },
  } }
  const response = await h.request("/v1/systemone", request)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(body)
  expect(response.headers.get("set-cookie")).toBeNull()
  expect(response.headers.get("authorization")).toBeNull()
  expect(network).toHaveBeenCalledTimes(1)
  const [url, init] = network.mock.calls[0]!
  expect(url).toBe("https://api.enterprise.githubcopilot.com/v1/systemone")
  expect(init).toMatchObject({ method: "POST", redirect: "manual" })
  expect(JSON.parse(String(init.body))).toEqual(request)
  const headers = new Headers(init.headers)
  expect(headers.get("authorization")).toBe("Bearer fixture-copilot-token")
  expect(headers.get("x-initiator")).toBe("user")
  expect(JSON.stringify([...headers])).not.toContain("fixture-client")
  expect(JSON.stringify([...headers])).not.toContain("fixture-github-token")
  const rows = h.db.query("SELECT * FROM requests").all() as Record<string, unknown>[]
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ path: "/v1/systemone", client_format: "systemone", upstream_format: "systemone", model, resolved_model: null, api_key_id: "env:default", input_tokens: 45, output_tokens: 1, status: "success", strategy: "copilot-systemone" })
  expect(JSON.stringify(events)).not.toContain(payload.state)
  expect(JSON.stringify(events)).not.toContain("fixture-copilot-token")
})

test("database key binding, auto resolution and quota accounting use the admitted upstream", async () => {
  const rule = createRoutingRule(h.db, ruleInput({ default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model }] }))
  const key = createApiKey(h.db, "Decision client", rule.id)
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  network.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "application/json" } }))
  const response = await h.request("/v1/systemone", { ...payload, model: "auto", upstream_id: "not-a-routing-override" }, "POST", key.key)
  expect(response.status).toBe(200)
  expect(JSON.parse(String(network.mock.calls[0]![1].body)).model).toBe(model)
  expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID).used_tokens).toBe(46)
  expect(h.db.query("SELECT attempt_ordinal, upstream_id, weighted_debit, usage_complete FROM quota_settlements").all()).toEqual([{ attempt_ordinal: 0, upstream_id: COPILOT_UPSTREAM_ID, weighted_debit: 46, usage_complete: 1 }])
  const end = events.find(event => event.type === "request_end")!
  expect(end.data).toMatchObject({ model: "auto", ruleId: rule.id, apiKeyId: key.id, routing: { resolved_model: model } })
})

test.each(["", "wrong", "fixture-internal"])("rejects unauthorized key %s before any upstream", async token => {
  expect((await h.request("/v1/systemone", payload, "POST", token)).status).toBe(401)
  expect(network).not.toHaveBeenCalled()
})

test("empty auth configuration does not grant access, and revoked keys stay rejected", async () => {
  const app = createApp({ db: h.db, githubToken: "fixture" })
  expect((await app.request("/v1/systemone", { method: "POST", body: JSON.stringify(payload) })).status).toBe(401)
  const key = createApiKey(h.db, "Revoked", COPILOT_RULE_ID)
  revokeApiKey(h.db, key.id)
  expect((await h.request("/v1/systemone", payload, "POST", key.key)).status).toBe(401)
  expect(network).not.toHaveBeenCalled()
})

test("key and global IP policies still deny decisions", async () => {
  const key = createApiKey(h.db, "Restricted", COPILOT_RULE_ID)
  writeIPPolicy(h.db, key.id, { enabled: true, ranges: ["192.0.2.1"] })
  expect((await h.request("/v1/systemone", payload, "POST", key.key)).status).toBe(403)
  state.ipWhitelistEnabled = true
  state.ipWhitelistRanges = parseRules(["192.0.2.1"])
  expect((await h.request("/v1/systemone", payload)).status).toBe(403)
  expect(network).not.toHaveBeenCalled()
})

test.each([false, true])("does not escape a custom key-bound route with conversion=%s", async allow_conversion => {
  const provider = h.upstream()
  const rule = createRoutingRule(h.db, ruleInput({ allow_conversion, default_chain: [{ upstream_id: provider.id, model }] }))
  const key = createApiKey(h.db, "Custom only", rule.id)
  expect((await h.request("/v1/systemone", payload, "POST", key.key)).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})

test("missing capabilities, exhausted quota and rate limiting fail before sending", async () => {
  h.copilot([])
  expect((await h.request("/v1/systemone", payload)).status).toBe(503)
  h.copilot([{ id: model, supported_endpoints: ["/v1/systemone"] }])
  state.rateLimitSeconds = 60
  state.rateLimitWait = false
  state.lastRequestTimestamp = Date.now()
  expect((await h.request("/v1/systemone", payload)).status).toBe(429)
  state.rateLimitSeconds = null
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  h.db.query("UPDATE quota_windows SET charged = 100").run()
  expect((await h.request("/v1/systemone", payload)).status).toBe(429)
  expect(network).not.toHaveBeenCalled()
})

test.each([null, [], {}, { ...payload, model: "" }, { model, questions: payload.questions }, { ...payload, questions: [] }, { ...payload, questions: {} }, { ...payload, questions: { x: null } }, { ...payload, questions: { x: { type: 1 } } }, { ...payload, questions: { x: { type: "" } } }, { ...payload, stream: true }, { ...payload, stream: "false" }])("rejects invalid local envelope %j", async request => {
  expect((await h.request("/v1/systemone", request)).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})

test("invalid JSON is rejected without upstream calls", async () => {
  expect((await h.app.request("/v1/systemone", { method: "POST", headers: { Authorization: "Bearer fixture-client" }, body: "{" })).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})

test("transport failures do not leak exception credentials or invent an upstream HTTP status", async () => {
  network.mockRejectedValueOnce(new Error("fixture-copilot-token connection failed"))
  const response = await h.request("/v1/systemone", payload)
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("fixture-copilot-token")
  expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ status: "error", statusCode: 502, upstreamStatus: null })
  expect(network).toHaveBeenCalledTimes(1)
})

test("client cancellation propagates into the one upstream attempt", async () => {
  const controller = new AbortController()
  network.mockImplementationOnce((_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
    controller.abort()
  }))
  const response = await h.app.request(new Request("http://fixture/v1/systemone", { method: "POST", headers: { Authorization: "Bearer fixture-client" }, body: JSON.stringify(payload), signal: controller.signal }))
  expect(response.status).toBe(499)
  expect(network).toHaveBeenCalledTimes(1)
  expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ status: "cancelled", upstreamStatus: null })
})

test.each([301, 401, 403, 404, 422, 429, 500, 529])("preserves upstream HTTP %s without refresh, redirects or retries", async status => {
  const error = '{"error":{"code":"fixture_error","message":"not entitled"}}'
  network.mockResolvedValueOnce(new Response(error, { status, headers: { "content-type": "application/json", location: "https://other.invalid", "set-cookie": "private" } }))
  const response = await h.request("/v1/systemone", payload)
  expect(response.status).toBe(status)
  expect(await response.text()).toBe(error)
  expect(response.headers.get("location")).toBeNull()
  expect(network).toHaveBeenCalledTimes(1)
  expect(events.filter(event => event.type === "request_end")).toHaveLength(1)
  expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ status: "error", statusCode: status, upstreamStatus: status })
})

test.each([200, 403])("redacts an upstream credential echo from HTTP %s errors and logs", async status => {
  network.mockResolvedValueOnce(jsonResponse({ error: { message: "fixture-copilot-token" } }, status))
  const response = await h.request("/v1/systemone", payload)
  expect(await response.text()).not.toContain("fixture-copilot-token")
  expect(JSON.stringify(events)).not.toContain("fixture-copilot-token")
  expect(events.find(event => event.type === "request_end")?.data?.status).toBe("error")
})

test.each(["usage", "response", "message"])("only top-level usage is used for accounting: %s", async field => {
  const raw = { answers: {}, [field]: field === "usage" ? null : { usage: { input_tokens: 123, output_tokens: 45 } } }
  network.mockResolvedValueOnce(jsonResponse(raw))
  const response = await h.request("/v1/systemone", payload)
  expect(await response.json()).toEqual(raw)
  expect(h.db.query("SELECT input_tokens, output_tokens, usage_present, usage_complete FROM quota_settlements").get()).toEqual({ input_tokens: null, output_tokens: null, usage_present: 0, usage_complete: 0 })
})

test.each([model, "auto"])("preserves exact request numbers with model=%s", async requestedModel => {
  h.bind(COPILOT_UPSTREAM_ID, model)
  network.mockResolvedValueOnce(jsonResponse({ answers: {} }))
  const raw = `{"model":"${requestedModel}","state":{"id":9007199254740993,"decimal":0.123456789012345678901,"huge":1e400,"negative":-0},"questions":{"gate":{"type":"noul","extra":[1e-400,{"rawJSON":"not a raw JSON value"}]}},"metadata":{"user_id":123},"user":{}}`
  const response = await h.app.request("/v1/systemone", { method: "POST", headers: { Authorization: "Bearer fixture-client", "content-type": "application/json" }, body: raw })
  expect(response.status).toBe(200)
  expect(network.mock.calls[0]![1].body).toBe(raw.replace('"model":"auto"', `"model":"${model}"`))
})

test.each([{ answers: [{ name: "gate", type: "predicate", probability: 0.4 }] }, { answers: { gate: { type: "noul", noul: 0.4 } } }, null])("never synthesizes missing model, usage, confidence or legend: %j", async raw => {
  network.mockResolvedValueOnce(jsonResponse(raw))
  expect(await (await h.request("/v1/systemone", payload)).json()).toEqual(raw)
  expect(h.db.query("SELECT input_tokens, output_tokens, resolved_model FROM requests").get()).toEqual({ input_tokens: null, output_tokens: null, resolved_model: null })
  expect(h.db.query("SELECT usage_present, usage_complete FROM quota_settlements").get()).toEqual({ usage_present: 0, usage_complete: 0 })
})

test.each([{ error: { message: "refused" } }, { answers: { gate: { type: "refusal" } } }, { answers: [{ type: "refusal" }] }])("preserves semantic failures and records error, not successful decisions: %j", async raw => {
  network.mockResolvedValueOnce(jsonResponse(raw))
  expect(await (await h.request("/v1/systemone", payload)).json()).toEqual(raw)
  expect(events.find(event => event.type === "request_end")).toMatchObject({ level: "error", data: { status: "error", statusCode: 200 } })
})

test("the existing text diagnostic does not send a chat prompt to a decision model", async () => {
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, { model })).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})
