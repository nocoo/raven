import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createApp } from "../../src/app"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../../src/core/routing-types"
import { createApiKey, revokeApiKey } from "../../src/db/keys"
import { getQuotaStatus, saveQuotaPolicy } from "../../src/db/quota"
import { createRoutingRule } from "../../src/db/routing-rules"
import { writeIPPolicy } from "../../src/db/ip-policy"
import { startRequestSink } from "../../src/db/request-sink"
import { state } from "../../src/lib/state"
import { parseRules } from "../../src/lib/ip-access"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { quotaPolicy, ruleInput } from "../db/routing-fixture"
import { chatResponse, generationEvents, jsonResponse, routingHarness, sseResponse } from "../helpers/routing"

const model = "gemini-raw-model"
const path = `/v1beta/models/${model}:generateContent`
const streamPath = `/v1beta/models/${model}:streamGenerateContent?alt=sse`
const body = { contents: [{ role: "user", parts: [{ text: "Hello" }] }] }
let h: ReturnType<typeof routingHarness>
let saved: typeof state
let network: ReturnType<typeof vi.spyOn>
let events: LogEvent[]
let stop: () => void
const listener = (event: LogEvent) => events.push(event)
const ends = () => events.filter(event => event.type === "request_end")

beforeEach(() => {
  h = routingHarness()
  saved = { ...state }
  Object.assign(state, { copilotToken: "fixture-copilot-token", copilotApiBaseUrl: "https://api.enterprise.githubcopilot.com", githubToken: "fixture-github-token", rateLimitSeconds: null, socks5Enabled: false, ipWhitelistEnabled: false })
  h.copilot([{ id: model, supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", tokenizer: "o200k_base", limits: { max_prompt_tokens: 10000, max_output_tokens: 1000 } } }])
  h.bind(COPILOT_UPSTREAM_ID, model)
  events = []
  logEmitter.on("log", listener)
  stop = startRequestSink(h.db)
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request"))
})

afterEach(() => {
  stop()
  logEmitter.off("log", listener)
  h.close()
  Object.assign(state, saved)
  vi.restoreAllMocks()
})

test("Google header authenticates generation and preserves raw model, unified logs and usage", async () => {
  network.mockResolvedValueOnce(jsonResponse(chatResponse(model)))
  const response = await h.app.request(path, { method: "POST", headers: { "x-goog-api-key": "fixture-client", "content-type": "application/json", origin: "http://fixture" }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ modelVersion: model, candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 12 } })
  expect(network).toHaveBeenCalledTimes(1)
  const [url, init] = network.mock.calls[0]!
  expect(url).toBe("https://api.enterprise.githubcopilot.com/chat/completions")
  expect(JSON.parse(String(init.body))).toMatchObject({ model, stream: false, messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  const headers = new Headers(init.headers)
  expect(headers.get("authorization")).toBe("Bearer fixture-copilot-token")
  expect(headers.has("x-goog-api-key")).toBe(false)
  expect(ends()).toHaveLength(1)
  expect(h.db.query("SELECT client_format, upstream_format, model, status, strategy FROM requests").all()).toEqual([{ client_format: "gemini", upstream_format: "openai", model, status: "success", strategy: "gemini-chat" }])
})

test.each(["copilot", "custom"])("output limits use the %s upstream's Chat field", async kind => {
  const strictModel = "gpt-5.4"
  h.copilot([{ id: strictModel, supported_endpoints: ["/chat/completions"] }])
  h.bind(kind === "copilot" ? COPILOT_UPSTREAM_ID : h.upstream().id, strictModel)
  network.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
    const sent = JSON.parse(String(init.body))
    expect(sent[kind === "copilot" ? "max_completion_tokens" : "max_tokens"]).toBe(40)
    expect(sent[kind === "copilot" ? "max_tokens" : "max_completion_tokens"]).toBeUndefined()
    return jsonResponse(chatResponse(strictModel))
  })
  const response = await h.request(`/v1beta/models/${strictModel}:generateContent`, { ...body, generationConfig: { maxOutputTokens: 40 } })
  expect(response.status).toBe(200)
  expect(network).toHaveBeenCalledTimes(1)
})

test("key-bound custom Chat routing resolves auto and debits the selected quota", async () => {
  const provider = h.upstream()
  const rule = createRoutingRule(h.db, ruleInput({ allow_conversion: true, default_chain: [{ upstream_id: provider.id, model }] }))
  const key = createApiKey(h.db, "Gemini", rule.id)
  saveQuotaPolicy(h.db, provider.id, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  network.mockResolvedValueOnce(jsonResponse(chatResponse(model)))
  const response = await h.request("/v1beta/models/auto:generateContent", body, "POST", key.key)
  expect(response.status).toBe(200)
  expect(network.mock.calls[0]![0]).toBe("https://upstream.invalid/v1/chat/completions")
  expect(new Headers(network.mock.calls[0]![1].headers).get("authorization")).toBe("Bearer fixture-secret")
  expect(getQuotaStatus(h.db, provider.id).used_tokens).toBe(12)
  expect(ends()[0]?.data).toMatchObject({ apiKeyId: key.id, routing: { resolved_model: model }, ruleId: rule.id })
})

test("streaming emits Gemini SSE and includes usage trailers with a single successful end", async () => {
  const chunks = generationEvents("openai", model)
  network.mockResolvedValueOnce(sseResponse([...chunks.slice(0, -1), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }, "[DONE]"]))
  const response = await h.request(streamPath, body)
  const wire = await response.text()
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(wire).toContain('"text":"pong"')
  expect(wire).toContain('"finishReason":"STOP"')
  expect(wire).toContain('"totalTokenCount":25')
  expect(wire).not.toContain("[DONE]")
  expect(ends()).toHaveLength(1)
  expect(ends()[0]?.data).toMatchObject({ status: "success", inputTokens: 20, outputTokens: 5 })
})

test.each([false, true])("thought usage is translated without changing quota charges (stream=%s)", async stream => {
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  const usage = { prompt_tokens: 10, completion_tokens: 24, total_tokens: 34, completion_tokens_details: { reasoning_tokens: 8 } }
  network.mockResolvedValueOnce(stream
    ? sseResponse([...generationEvents("openai", model).slice(0, -1), { choices: [], usage }, "[DONE]"])
    : jsonResponse({ ...chatResponse(model), usage }))
  const response = await h.request(stream ? streamPath : path, body)
  const wire = await response.text()
  expect(wire).toContain('"thoughtsTokenCount":8')
  expect(wire).toContain('"candidatesTokenCount":16')
  expect(wire).toContain('"totalTokenCount":34')
  expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID).used_tokens).toBe(34)
  expect(ends()).toHaveLength(1)
  expect(ends()[0]?.data).toMatchObject({ status: "success", inputTokens: 10, outputTokens: 24 })
})

test.each(["truncated", "inline", "malformed"])("stream %s yields Google error and records failure", async kind => {
  const first = generationEvents("openai", model)[0]!
  network.mockResolvedValueOnce(sseResponse(kind === "truncated" ? [first] : [first, kind === "inline" ? { error: { message: "fixture-secret" } } : "{", "[DONE]"]))
  const response = await h.request(streamPath, body)
  const wire = await response.text()
  expect(response.status).toBe(200)
  expect(wire).toContain('"status":"UNAVAILABLE"')
  expect(wire).not.toContain("fixture-secret")
  expect(ends()).toHaveLength(1)
  expect(ends()[0]?.data).toMatchObject({ status: "error", statusCode: 200 })
})

test("model list and get use cached catalog, filter non-chat models and expose known limits", async () => {
  h.copilot([
    { id: model, name: "Gemini raw", supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", limits: { max_prompt_tokens: 10000, max_output_tokens: 1000 } } },
    { id: "image", capabilities: { type: "image" }, supported_endpoints: ["/v1/images/generations"] },
    { id: "responses-only", supported_endpoints: ["/responses"] }, { id: "legacy" },
  ])
  const list = await (await h.request("/v1beta/models")).json() as { models: { baseModelId: string }[] }
  expect(list.models.map(entry => entry.baseModelId)).toEqual(expect.arrayContaining([model, "legacy", "auto"]))
  expect(list.models.map(entry => entry.baseModelId)).not.toContain("image")
  expect(list.models.map(entry => entry.baseModelId)).not.toContain("responses-only")
  expect(await (await h.request(`/v1beta/models/${model}`)).json()).toMatchObject({ name: `models/${model}`, inputTokenLimit: 10000, outputTokenLimit: 1000, supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"] })
  expect((await h.request("/v1beta/models/absent")).status).toBe(404)
  expect(network).not.toHaveBeenCalled()
})

test("countTokens estimates locally, honors routing, and does not debit quota", async () => {
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  const response = await h.request(`/v1beta/models/${model}:countTokens`, body)
  expect(response.status).toBe(200)
  expect(response.headers.get("x-raven-token-count")).toBe("estimate")
  expect((await response.json() as { totalTokens: number }).totalTokens).toBeGreaterThan(0)
  expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID).used_tokens).toBe(0)
  expect(ends()).toHaveLength(1)
  expect(ends()[0]?.data).toMatchObject({ estimationAvailable: true, status: "success" })
  for (const name of [model, `models/${model}`]) {
    expect((await h.request(`/v1beta/models/${model}:countTokens`, { generateContentRequest: { ...body, model: name } })).status).toBe(200)
  }
  expect((await h.request(`/v1beta/models/${model}:countTokens`, { generateContentRequest: { ...body, model: "other" } })).status).toBe(400)
  expect((await h.request(`/v1beta/models/${model}:countTokens`, { ...body, generateContentRequest: { ...body, model } })).status).toBe(400)
  h.copilot([{ id: model }])
  expect((await h.request(`/v1beta/models/${model}:countTokens`, body)).status).toBe(503)
  h.bind(COPILOT_UPSTREAM_ID, model, { allow_conversion: false })
  expect((await h.request(`/v1beta/models/${model}:countTokens`, body)).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})

test.each(["", "wrong", "fixture-internal"])("Google header rejects unauthorized credential %s", async key => {
  const response = await h.app.request(path, { method: "POST", headers: { "x-goog-api-key": key, origin: "http://fixture" }, body: JSON.stringify(body) })
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: { code: 401, status: "UNAUTHENTICATED" } })
  expect(response.headers.get("access-control-allow-origin")).toBe("http://fixture")
  expect(network).not.toHaveBeenCalled()
})

test("Google keys cannot authorize management or other API families; query keys are not accepted", async () => {
  for (const route of ["/api/keys", "/v1/models", "/v1beta/models?key=fixture-client"]) {
    expect((await h.app.request(route, { headers: route.includes("?key") ? {} : { "x-goog-api-key": "fixture-client" } }, { remoteAddress: "127.0.0.1" })).status).toBe(401)
  }
  const key = createApiKey(h.db, "Revoked", COPILOT_RULE_ID)
  revokeApiKey(h.db, key.id)
  expect((await h.request(path, body, "POST", key.key)).status).toBe(401)
  const empty = createApp({ db: h.db, githubToken: "fixture" })
  expect((await empty.request(path, { method: "POST", body: JSON.stringify(body) })).status).toBe(401)
  expect(network).not.toHaveBeenCalled()
})

test("key and global IP policies reject before upstream", async () => {
  const key = createApiKey(h.db, "Restricted", COPILOT_RULE_ID)
  writeIPPolicy(h.db, key.id, { enabled: true, ranges: ["192.0.2.1"] })
  expect((await h.request(path, body, "POST", key.key)).status).toBe(403)
  state.ipWhitelistEnabled = true
  state.ipWhitelistRanges = parseRules(["192.0.2.1"])
  expect((await h.request(path, body)).status).toBe(403)
  expect(network).not.toHaveBeenCalled()
})

test("conversion must be enabled and target Chat; routing rejection logs exactly once", async () => {
  h.bind(COPILOT_UPSTREAM_ID, model, { allow_conversion: false })
  expect((await h.request(path, body)).status).toBe(400)
  expect(ends()).toHaveLength(1)
  const provider = h.upstream({ format: "responses" })
  h.bind(provider.id, model)
  expect((await h.request(path, body)).status).toBe(400)
  expect(ends()).toHaveLength(2)
  h.bind(COPILOT_UPSTREAM_ID, model)
  h.copilot([{ id: model, supported_endpoints: ["/responses"] }])
  expect((await h.request(path, body)).status).toBe(400)
  h.copilot([{ id: model }])
  network.mockResolvedValueOnce(jsonResponse(chatResponse(model)))
  expect((await h.request(path, body)).status).toBe(200)
  expect(network).toHaveBeenCalledTimes(1)
})

test("quota exhaustion and rate limit block Gemini before sending", async () => {
  state.rateLimitSeconds = 60
  state.rateLimitWait = false
  state.lastRequestTimestamp = Date.now()
  expect((await h.request(path, body)).status).toBe(429)
  state.rateLimitSeconds = null
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  h.db.query("UPDATE quota_windows SET charged = 100").run()
  expect((await h.request(path, body)).status).toBe(429)
  expect(network).not.toHaveBeenCalled()
})

test("invalid JSON, parameters and operations fail locally", async () => {
  expect((await h.request(path, { ...body, generationConfig: { topK: 64 } })).status).toBe(400)
  expect((await h.request(path, { contents: [{ role: "model", parts: [{ functionCall: { name: "read" } }] }] })).status).toBe(400)
  expect((await h.request(`/v1beta/models/${model}:streamGenerateContent?alt=json`, body)).status).toBe(400)
  expect((await h.request(`/v1beta/models/${model}:unknown`, body)).status).toBe(404)
  expect((await h.request(`/v1beta/models/${model}`, body)).status).toBe(404)
  expect((await h.app.request(path, { method: "POST", headers: { Authorization: "Bearer fixture-client" }, body: "{" })).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})

test.each([401, 403, 429, 500])("upstream HTTP %s becomes Google error without retries or credential echoes", async status => {
  network.mockResolvedValueOnce(jsonResponse({ error: { message: "fixture-copilot-token failure" } }, status))
  const response = await h.request(path, body)
  expect(response.status).toBe(status)
  const text = await response.text()
  expect(JSON.parse(text)).toMatchObject({ error: { code: status } })
  expect(text).not.toContain("fixture-copilot-token")
  expect(ends()).toHaveLength(1)
  expect(network).toHaveBeenCalledTimes(1)
})

test("malformed JSON and semantic errors return 502 and record a single failure", async () => {
  for (const upstream of [jsonResponse({ error: { message: "private" } }), jsonResponse({}), new Response("{", { headers: { "content-type": "application/json" } })]) {
    network.mockResolvedValueOnce(upstream)
    const response = await h.request(path, body)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 502 } })
  }
  expect(ends()).toHaveLength(3)
  expect(ends().every(event => event.data?.status === "error")).toBe(true)
})

test("transport failure and client cancellation remain distinct and never retry", async () => {
  network.mockRejectedValueOnce(new Error("connection failed"))
  expect((await h.request(path, body)).status).toBe(502)
  const controller = new AbortController()
  network.mockImplementationOnce((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
    controller.abort()
  }))
  const response = await h.app.request(new Request(`http://fixture${path}`, { method: "POST", headers: { "x-goog-api-key": "fixture-client" }, body: JSON.stringify(body), signal: controller.signal }))
  expect(response.status).toBe(499)
  expect(await response.json()).toMatchObject({ error: { status: "CANCELLED" } })
  expect(ends().map(event => event.data?.status)).toEqual(["error", "cancelled"])
  expect(network).toHaveBeenCalledTimes(2)
})
