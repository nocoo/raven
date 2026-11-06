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

const cases = [
  {
    model: "gpt-6-luna-decisions",
    path: "/v1/decisions",
    endpoint: "/v1/decisions",
    strategy: "copilot-decisions",
    payload: {
      model: "gpt-6-luna-decisions",
      input: "A small code change has not been tested.",
      questions: [{ name: "next_step", instructions: "Choose the next step.", type: "choice", choices: [{ value: "test" }, { value: "merge" }] }],
    },
    response: { model: "gpt-6-luna-decisions", answers: [{ name: "next_step", choice: "test", confidence: 0.997 }], usage: { input_tokens: 45, output_tokens: 1 } },
  },
  {
    model: "gpt-image-2.5-flare",
    path: "/v1/images/generations",
    endpoint: "/v1/images/generations",
    strategy: "copilot-images",
    payload: { model: "gpt-image-2.5-flare", prompt: "A single red circle on a white background.", n: 1, size: "1024x1024" },
    response: { created: 123, data: [{ b64_json: "AA==", extra: true }], usage: { input_tokens: 4, output_tokens: 1 } },
  },
] as const

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

for (const entry of cases) {
  test(`${entry.model}: unified key sends one native request and preserves raw response`, async () => {
    h.copilot([{ id: entry.model, capabilities: { type: entry.strategy === "copilot-decisions" ? "decisions" : "image" }, supported_endpoints: [entry.endpoint] }])
    const raw = JSON.stringify(entry.response)
    network.mockResolvedValueOnce(new Response(raw, { headers: { "content-type": "application/json", "set-cookie": "private", authorization: "private" } }))
    const request = { ...entry.payload, extra: { keep: [null, true] } }
    const response = await h.request(entry.path, request)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(raw)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("authorization")).toBeNull()
    expect(network).toHaveBeenCalledTimes(1)
    const [url, init] = network.mock.calls[0]!
    expect(url).toBe(`https://api.enterprise.githubcopilot.com${entry.endpoint}`)
    expect(init).toMatchObject({ method: "POST", redirect: "manual" })
    expect(JSON.parse(String(init.body))).toEqual(request)
    const headers = new Headers(init.headers)
    expect(headers.get("authorization")).toBe("Bearer fixture-copilot-token")
    expect(headers.get("x-initiator")).toBe("user")
    expect(JSON.stringify([...headers])).not.toContain("fixture-client")
    expect(JSON.stringify([...headers])).not.toContain("fixture-github-token")
    const rows = h.db.query("SELECT * FROM requests").all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: entry.path, client_format: entry.strategy === "copilot-decisions" ? "decisions" : "images", upstream_format: entry.strategy === "copilot-decisions" ? "decisions" : "images", model: entry.model, api_key_id: "env:default", status: "success", strategy: entry.strategy })
    expect(JSON.stringify(events)).not.toContain("fixture-copilot-token")
    if (entry.strategy === "copilot-images") expect(JSON.stringify(events)).not.toContain("AA==")
  })

  test(`${entry.model}: database key binding, auto resolution and quota accounting`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    const rule = createRoutingRule(h.db, ruleInput({ default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model: entry.model }] }))
    const key = createApiKey(h.db, `${entry.strategy} client`, rule.id)
    saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
    network.mockResolvedValueOnce(jsonResponse(entry.response))
    const response = await h.request(entry.path, { ...entry.payload, model: "auto", upstream_id: "not-a-routing-override" }, "POST", key.key)
    expect(response.status).toBe(200)
    const sent = JSON.parse(String(network.mock.calls[0]![1].body))
    expect(sent.model).toBe(entry.model)
    expect(sent).not.toHaveProperty("upstream_id")
    const usageTokens = entry.response.usage.input_tokens + entry.response.usage.output_tokens
    expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID).used_tokens).toBe(usageTokens)
    expect(h.db.query("SELECT attempt_ordinal, upstream_id, weighted_debit, usage_complete FROM quota_settlements").all()).toEqual([{ attempt_ordinal: 0, upstream_id: COPILOT_UPSTREAM_ID, weighted_debit: usageTokens, usage_complete: 1 }])
    const end = events.find(event => event.type === "request_end")!
    expect(end.data).toMatchObject({ model: "auto", ruleId: rule.id, apiKeyId: key.id, routing: { resolved_model: entry.model } })
  })

  test(`${entry.model}: key and global IP policies deny before upstream`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    const key = createApiKey(h.db, "Restricted", COPILOT_RULE_ID)
    writeIPPolicy(h.db, key.id, { enabled: true, ranges: ["192.0.2.1"] })
    expect((await h.request(entry.path, entry.payload, "POST", key.key)).status).toBe(403)
    state.ipWhitelistEnabled = true
    state.ipWhitelistRanges = parseRules(["192.0.2.1"])
    expect((await h.request(entry.path, entry.payload)).status).toBe(403)
    expect(network).not.toHaveBeenCalled()
  })

  test(`${entry.model}: custom key-bound route rejects conversion`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    const provider = h.upstream()
    const rule = createRoutingRule(h.db, ruleInput({ allow_conversion: true, default_chain: [{ upstream_id: provider.id, model: entry.model }] }))
    const key = createApiKey(h.db, "Custom only", rule.id)
    expect((await h.request(entry.path, entry.payload, "POST", key.key)).status).toBe(400)
    expect(network).not.toHaveBeenCalled()
  })

  test(`${entry.model}: missing capabilities, exhausted quota and rate limiting fail before sending`, async () => {
    h.copilot([])
    expect((await h.request(entry.path, entry.payload)).status).toBe(503)
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    state.rateLimitSeconds = 60
    state.rateLimitWait = false
    state.lastRequestTimestamp = Date.now()
    expect((await h.request(entry.path, entry.payload)).status).toBe(429)
    state.rateLimitSeconds = null
    saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
    h.db.query("UPDATE quota_windows SET charged = 100").run()
    expect((await h.request(entry.path, entry.payload)).status).toBe(429)
    expect(network).not.toHaveBeenCalled()
  })

  test(`${entry.model}: transport failures and cancellation do not retry or invent status`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    network.mockRejectedValueOnce(new Error("fixture-copilot-token connection failed"))
    const response = await h.request(entry.path, entry.payload)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("fixture-copilot-token")
    expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ status: "error", statusCode: 502, upstreamStatus: null })

    const controller = new AbortController()
    network.mockImplementationOnce((_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      controller.abort()
    }))
    const cancelled = await h.app.request(new Request(`http://fixture${entry.path}`, { method: "POST", headers: { Authorization: "Bearer fixture-client", "content-type": "application/json" }, body: JSON.stringify(entry.payload), signal: controller.signal }))
    expect(cancelled.status).toBe(499)
    expect(network).toHaveBeenCalledTimes(2)
  })

  test.each([301, 401, 403, 404, 422, 429, 500, 529])(`${entry.model}: preserves upstream HTTP %s without redirects or retries`, async status => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    const error = '{"error":{"code":"fixture_error","message":"not entitled"}}'
    network.mockResolvedValueOnce(new Response(error, { status, headers: { "content-type": "application/json", location: "https://other.invalid", "set-cookie": "private" } }))
    const response = await h.request(entry.path, entry.payload)
    expect(response.status).toBe(status)
    expect(await response.text()).toBe(error)
    expect(response.headers.get("location")).toBeNull()
    expect(network).toHaveBeenCalledTimes(1)
  })
}

for (const entry of cases) {
  test(`${entry.model}: unauthorized credentials are rejected with zero upstream calls`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    for (const token of ["", "wrong", "fixture-internal"]) {
      expect((await h.request(entry.path, entry.payload, "POST", token)).status).toBe(401)
    }
    expect(network).not.toHaveBeenCalled()
  })

  test(`${entry.model}: invalid local envelope and JSON are rejected before upstream`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    const invalid = entry.strategy === "copilot-decisions"
      ? [{ model: entry.model }, { ...entry.payload, questions: [] }, { ...entry.payload, questions: [{ name: "gate", type: 1 }] }, { ...entry.payload, stream: true }]
      : [{ model: entry.model }, { ...entry.payload, prompt: "" }, { ...entry.payload, stream: true }]
    for (const request of invalid) expect((await h.request(entry.path, request)).status).toBe(400)
    expect((await h.app.request(entry.path, { method: "POST", headers: { Authorization: "Bearer fixture-client" }, body: "{" })).status).toBe(400)
    expect(network).not.toHaveBeenCalled()
  })

  test(`${entry.model}: malformed successful JSON and unexpected content type return 502`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    network.mockResolvedValueOnce(new Response("private garbage", { headers: { "content-type": "application/json" } }))
    expect((await h.request(entry.path, entry.payload)).status).toBe(502)
    network.mockResolvedValueOnce(new Response("unexpected", { status: 200, headers: { "content-type": "text/html" } }))
    expect((await h.request(entry.path, entry.payload)).status).toBe(502)
    expect(network).toHaveBeenCalledTimes(2)
  })

  test(`${entry.model}: HTTP 200 semantic failures remain native and record errors`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    const raw = entry.strategy === "copilot-decisions"
      ? [{ error: { message: "refused" } }, { answers: [{ name: "gate", type: "refusal" }] }]
      : [{ error: { message: "refused" } }]
    for (const body of raw) {
      network.mockResolvedValueOnce(jsonResponse(body))
      const response = await h.request(entry.path, entry.payload)
      expect(await response.json()).toEqual(body)
      expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ status: "error", statusCode: 200 })
    }
  })

  test(`${entry.model}: exact request numbers and unknown fields reach the upstream`, async () => {
    h.bind(COPILOT_UPSTREAM_ID, entry.model)
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    network.mockResolvedValueOnce(jsonResponse(entry.response))
    const raw = entry.strategy === "copilot-decisions"
      ? `{"model":"${entry.model}","input":{"id":9007199254740993,"decimal":0.123456789012345678901},"questions":[{"name":"gate","type":"noul","extra":1e-400}],"metadata":{"keep":true}}`
      : `{"model":"${entry.model}","prompt":"fixture","n":1,"unknown":1e-400,"metadata":{"keep":true}}`
    const response = await h.app.request(entry.path, { method: "POST", headers: { Authorization: "Bearer fixture-client", "content-type": "application/json" }, body: raw })
    expect(response.status).toBe(200)
    expect(network.mock.calls[0]![1].body).toBe(raw)
  })
}

for (const entry of cases) {
  test(`${entry.model}: missing usage never invents quota or token fields`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    const raw = entry.strategy === "copilot-decisions"
      ? { answers: [{ name: "next_step", choice: "test" }] }
      : { created: 123, data: [{ b64_json: "AA==" }] }
    network.mockResolvedValueOnce(jsonResponse(raw))
    const response = await h.request(entry.path, entry.payload)
    expect(await response.json()).toEqual(raw)
    expect(h.db.query("SELECT input_tokens, output_tokens, usage_present, usage_complete FROM quota_settlements").get()).toEqual({ input_tokens: null, output_tokens: null, usage_present: 0, usage_complete: 0 })
  })

  test(`${entry.model}: redacts credential echoes from HTTP 200 and HTTP error bodies`, async () => {
    h.copilot([{ id: entry.model, supported_endpoints: [entry.endpoint] }])
    network.mockResolvedValueOnce(jsonResponse({ error: { message: "fixture-copilot-token" } }))
    const success = await h.request(entry.path, entry.payload)
    expect(await success.text()).not.toContain("fixture-copilot-token")
    network.mockResolvedValueOnce(new Response('{"error":{"message":"fixture-copilot-token"}}', { status: 403, headers: { "content-type": "application/json" } }))
    const failure = await h.request(entry.path, entry.payload)
    expect(await failure.text()).not.toContain("fixture-copilot-token")
    expect(JSON.stringify(events)).not.toContain("fixture-copilot-token")
  })
}

test("revoked database keys stay rejected with zero upstream calls", async () => {
  h.copilot([{ id: "gpt-6-luna-decisions", supported_endpoints: ["/v1/decisions"] }])
  const key = createApiKey(h.db, "Revoked", COPILOT_RULE_ID)
  revokeApiKey(h.db, key.id)
  expect((await h.request("/v1/decisions", cases[0].payload, "POST", key.key)).status).toBe(401)
  expect(network).not.toHaveBeenCalled()
})

test("empty auth configuration does not grant access", async () => {
  h.copilot([{ id: "gpt-image-2.5-flare", supported_endpoints: ["/v1/images/generations"] }])
  const app = createApp({ db: h.db, githubToken: "fixture" })
  expect((await app.request("/v1/images/generations", { method: "POST", body: JSON.stringify(cases[1].payload) })).status).toBe(401)
  expect(network).not.toHaveBeenCalled()
})

test("gpt-41-copilot is not a handled completion or image-edit endpoint", async () => {
  h.copilot([])
  expect((await h.request("/v1/decisions", { model: "gpt-41-copilot", input: "x", questions: [{ name: "x", type: "noul" }] })).status).toBe(503)
  expect((await h.request("/v1/completions", { model: "gpt-41-copilot", prompt: "x" })).status).toBe(404)
  expect((await h.request("/v1/images/edits", { model: "gpt-image-2.5-flare", prompt: "x" })).status).toBe(404)
  expect(network).not.toHaveBeenCalled()
})
