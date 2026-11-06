import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createApp } from "../../src/app"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../../src/core/routing-types"
import { createApiKey, revokeApiKey } from "../../src/db/keys"
import { writeIPPolicy } from "../../src/db/ip-policy"
import { getQuotaStatus, saveQuotaPolicy } from "../../src/db/quota"
import { startRequestSink } from "../../src/db/request-sink"
import { createRoutingRule } from "../../src/db/routing-rules"
import { parseRules } from "../../src/lib/ip-access"
import { state } from "../../src/lib/state"
import type { LogEvent } from "../../src/util/log-event"
import { logEmitter } from "../../src/util/log-emitter"
import { quotaPolicy, ruleInput } from "../db/routing-fixture"
import { jsonResponse, routingHarness } from "../helpers/routing"

const path = "/v1/images/edits"
const model = "gpt-image-2.5-flare"
const bytes = new Uint8Array([0, 255, 13, 10, 128, 42])
const responseBody = { created: 123, data: [{ b64_json: "synthetic-image-output" }], usage: { input_tokens: 4, output_tokens: 1 } }
const localFetch = globalThis.fetch
let h: ReturnType<typeof routingHarness>
let network: ReturnType<typeof vi.spyOn>
let saved: typeof state
let stop: () => void
let events: LogEvent[]
const listener = (event: LogEvent) => events.push(event)

function form(imageName = "image") {
  const body = new FormData()
  body.append("model", model)
  body.append("prompt", "Replace the background.")
  body.append(imageName, new File([bytes], "source.png", { type: "image/png" }))
  return body
}

function request(body: FormData = form(), token = "fixture-client", signal?: AbortSignal) {
  return h.app.request(path, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body, ...(signal ? { signal } : {}),
  }, { remoteAddress: "127.0.0.1" })
}

beforeEach(() => {
  h = routingHarness()
  saved = { ...state }
  Object.assign(state, { copilotToken: "fixture-copilot-token", copilotApiBaseUrl: "https://api.enterprise.githubcopilot.com", githubToken: "fixture-github-token", rateLimitSeconds: null, socks5Enabled: false, ipWhitelistEnabled: false })
  h.copilot([{ id: model, supported_endpoints: [path] }])
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

test.each(["image", "image[]"])("preserves %s files, mask, repeated/unknown fields and native response", async imageName => {
  const body = form(imageName)
  body.append(imageName, new File([bytes], "second.webp", { type: "image/webp" }))
  body.append("mask", new File([bytes], "mask.png", { type: "image/png" }))
  body.append("quality", "low")
  body.append("output_format", "png")
  body.append("n", "1")
  body.append("stream", "false")
  body.append("user", "not-a-session-override")
  body.append("extra", "9007199254740993")
  body.append("extra", "0.123456789012345678901")
  body.append("upstream_id", "https://attacker.invalid")
  body.append("imageEndpoint", "/v1/images/generations")
  body.append("unknown_file", new File([bytes], "extra.bin", { type: "application/octet-stream" }))
  const raw = JSON.stringify(responseBody)
  network.mockResolvedValueOnce(new Response(raw, { headers: { "content-type": "application/json", "set-cookie": "private", authorization: "private" } }))
  const response = await request(body)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(raw)
  expect(response.headers.get("set-cookie")).toBeNull()
  expect(response.headers.get("authorization")).toBeNull()
  expect(network).toHaveBeenCalledTimes(1)
  const [url, init] = network.mock.calls[0]!
  expect(url).toBe(`https://api.enterprise.githubcopilot.com${path}`)
  expect(init).toMatchObject({ method: "POST", redirect: "manual" })
  const headers = new Headers(init.headers)
  expect(headers.get("content-type")).toBeNull()
  expect(headers.get("authorization")).toBe("Bearer fixture-copilot-token")
  expect(headers.get("x-initiator")).toBe("user")
  expect(headers.get("copilot-integration-id")).toBe("vscode-chat")
  expect(JSON.stringify([...headers])).not.toContain("fixture-client")
  const wire = new Request(String(url), init)
  expect(wire.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
  const sent = await wire.formData()
  expect([...sent.keys()]).toEqual([...body.keys()])
  for (const [name, value] of body) {
    if (typeof value === "string") expect(sent.getAll(name)).toEqual(body.getAll(name))
  }
  const files = sent.getAll(imageName)
  expect(files).toHaveLength(2)
  for (const [index, file] of files.entries()) {
    expect(file).toBeInstanceOf(File)
    if (typeof file === "string") throw new Error("Expected an uploaded file")
    expect(file.name).toBe(index === 0 ? "source.png" : "second.webp")
    expect(file.type).toBe(index === 0 ? "image/png" : "image/webp")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  }
  for (const name of ["mask", "unknown_file"]) {
    const file = sent.get(name)
    expect(file).toBeInstanceOf(File)
    if (!(file instanceof File)) throw new Error("Expected an uploaded file")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  }
  const rows = h.db.query("SELECT path, client_format, upstream_format, strategy, model, status FROM requests").all()
  expect(rows).toEqual([{ path, client_format: "images", upstream_format: "images", strategy: "copilot-images", model, status: "success" }])
  expect(JSON.stringify(events)).not.toContain("synthetic-image-output")
  expect(JSON.stringify(events)).not.toContain("source.png")
  expect(JSON.stringify(events)).not.toContain("not-a-session-override")
})

test("database key auto resolution replaces only model and settles reported image usage", async () => {
  const rule = createRoutingRule(h.db, ruleInput({ default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model }] }))
  const key = createApiKey(h.db, "Image edit client", rule.id)
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  const body = form()
  body.set("model", "auto")
  network.mockResolvedValueOnce(jsonResponse(responseBody))
  expect((await request(body, key.key)).status).toBe(200)
  const sent = network.mock.calls[0]![1].body
  expect(sent).toBeInstanceOf(FormData)
  if (!(sent instanceof FormData)) throw new Error("Expected multipart")
  expect(sent.getAll("model")).toEqual([model])
  expect(sent.get("prompt")).toBe(body.get("prompt"))
  expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID).used_tokens).toBe(5)
  expect(h.db.query("SELECT attempt_ordinal, weighted_debit, usage_complete FROM quota_settlements").all()).toEqual([{ attempt_ordinal: 0, weighted_debit: 5, usage_complete: 1 }])
  expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ model: "auto", apiKeyId: key.id, routing: { resolved_model: model } })
})

test.each([true, false])("routes an upload across quota reset when the window was already advanced=%s", async advanced => {
  const initial = Date.now()
  let now = initial
  vi.spyOn(Date, "now").mockImplementation(() => now)
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: initial + 1000 }), initial)
  const oldWindow = getQuotaStatus(h.db, COPILOT_UPSTREAM_ID, initial).window_id
  h.db.query("UPDATE quota_windows SET charged = 100 WHERE id = ?").run(oldWindow)
  const encoded = new Request("http://localhost", { method: "POST", body: form() })
  const contentType = encoded.headers.get("content-type")!
  const bytes = new Uint8Array(await encoded.arrayBuffer())
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const parsing = new Promise<void>(resolve => { entered = resolve })
  const originalFormData = Request.prototype.formData
  vi.spyOn(Request.prototype, "formData").mockImplementation(function (this: Request) {
    entered()
    return originalFormData.call(this)
  })
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(bytes.slice(0, 10))
      await blocked
      controller.enqueue(bytes.slice(10))
      controller.close()
    },
  })
  network.mockResolvedValueOnce(jsonResponse(responseBody))
  const pending = h.app.request(path, {
    method: "POST", headers: { Authorization: "Bearer fixture-client", "content-type": contentType }, body,
  }, { remoteAddress: "127.0.0.1" })
  try {
    await parsing
    now = initial + 1001
    if (advanced) expect(getQuotaStatus(h.db, COPILOT_UPSTREAM_ID, now).window_id).not.toBe(oldWindow)
    release()
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(responseBody)
    expect(network).toHaveBeenCalledOnce()
    const current = getQuotaStatus(h.db, COPILOT_UPSTREAM_ID, now)
    expect(current).toMatchObject({ healthy: true, used_tokens: 5 })
    expect(current.window_id).not.toBe(oldWindow)
    expect(h.db.query("SELECT window_id, captured_at, weighted_debit FROM quota_settlements").get()).toEqual({
      window_id: current.window_id, captured_at: now, weighted_debit: 5,
    })
    expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ routing: { admitted_at: now } })
  } finally {
    release()
  }
})

test("real loopback HTTP encodes multipart with a matching boundary and isolated SQLite", async () => {
  const received: { headers: Headers; form: FormData }[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async req => {
      received.push({ headers: req.headers, form: await req.formData() })
      return jsonResponse(responseBody)
    },
  })
  const proxy = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: req => h.app.fetch(req, { remoteAddress: "127.0.0.1" }),
  })
  try {
    network.mockImplementationOnce((_input: unknown, init: RequestInit) => localFetch(upstream.url, init))
    const response = await localFetch(new URL(path, proxy.url), {
      method: "POST", headers: { Authorization: "Bearer fixture-client" }, body: form(),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(responseBody)
    expect(network).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(1)
    expect(received[0]!.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
    const sent = received[0]!.form
    const image = sent.get("image")
    if (!(image instanceof File)) throw new Error("Expected a wire image")
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes)
    expect(sent.get("model")).toBe(model)
    expect(h.db.query("SELECT path, status FROM requests").all()).toEqual([{ path, status: "success" }])
  } finally {
    await Promise.all([proxy.stop(true), upstream.stop(true)])
  }
})

test("missing usage remains unobserved without inventing tokens", async () => {
  network.mockResolvedValueOnce(jsonResponse({ data: [] }))
  expect((await request()).status).toBe(200)
  expect(h.db.query("SELECT input_tokens, output_tokens, usage_present, usage_complete FROM quota_settlements").get()).toEqual({ input_tokens: null, output_tokens: null, usage_present: 0, usage_complete: 0 })
})

test("invalid, revoked, internal and missing credentials never reach upstream", async () => {
  for (const token of ["", "wrong", "fixture-internal"]) expect((await request(form(), token)).status).toBe(401)
  const key = createApiKey(h.db, "Revoked", COPILOT_RULE_ID)
  revokeApiKey(h.db, key.id)
  expect((await request(form(), key.key)).status).toBe(401)
  const app = createApp({ db: h.db, githubToken: "fixture" })
  expect((await app.request(path, { method: "POST", body: form() })).status).toBe(401)
  expect(network).not.toHaveBeenCalled()
})

test("key/global IP policies, quotas and rate limits apply before sending", async () => {
  const key = createApiKey(h.db, "Restricted", COPILOT_RULE_ID)
  writeIPPolicy(h.db, key.id, { enabled: true, ranges: ["192.0.2.1"] })
  expect((await request(form(), key.key)).status).toBe(403)
  state.ipWhitelistEnabled = true
  state.ipWhitelistRanges = parseRules(["192.0.2.1"])
  expect((await request()).status).toBe(403)
  state.ipWhitelistEnabled = false
  state.rateLimitSeconds = 60
  state.rateLimitWait = false
  state.lastRequestTimestamp = Date.now()
  expect((await request()).status).toBe(429)
  state.rateLimitSeconds = null
  saveQuotaPolicy(h.db, COPILOT_UPSTREAM_ID, quotaPolicy({ next_reset_at: Date.now() + 3600000 }))
  h.db.query("UPDATE quota_windows SET charged = 100").run()
  expect((await request()).status).toBe(429)
  expect(network).not.toHaveBeenCalled()
})

test("generations capability cannot authorize edits, and custom-only rules cannot convert", async () => {
  h.copilot([{ id: model, supported_endpoints: ["/v1/images/generations"] }])
  expect((await request()).status).toBe(503)
  h.copilot([{ id: model, supported_endpoints: [path] }])
  const provider = h.upstream()
  const rule = createRoutingRule(h.db, ruleInput({ allow_conversion: true, default_chain: [{ upstream_id: provider.id, model }] }))
  const key = createApiKey(h.db, "Custom only", rule.id)
  expect((await request(form(), key.key)).status).toBe(400)
  expect(network).not.toHaveBeenCalled()
})

test("rejects missing, ambiguous or non-file envelope fields and streaming before upstream", async () => {
  for (const field of ["model", "prompt", "image"]) {
    const body = form()
    body.delete(field)
    expect((await request(body)).status).toBe(400)
  }
  for (const field of ["model", "prompt"]) {
    for (const value of ["", " ", new File([bytes], "not-text.bin")]) {
      const body = form()
      body.set(field, value)
      expect((await request(body)).status).toBe(400)
    }
    const body = form()
    body.append(field, "duplicate")
    expect((await request(body)).status).toBe(400)
  }
  for (const value of ["not-a-file", new File([], "empty.png")]) {
    const body = form()
    body.set("image", value)
    expect((await request(body)).status).toBe(400)
  }
  for (const stream of ["true", "", new File([bytes], "stream.bin")]) {
    const body = form()
    body.set("stream", stream)
    expect((await request(body)).status).toBe(400)
  }
  expect(network).not.toHaveBeenCalled()
})

test("rejects JSON, URL-encoded and malformed multipart without echoing input", async () => {
  for (const contentType of [undefined, "application/json", "application/x-www-form-urlencoded", "multipart/form-data; boundary=broken"]) {
    const response = await h.app.request(path, { method: "POST", headers: { Authorization: "Bearer fixture-client", ...(contentType ? { "content-type": contentType } : {}) }, body: "private-upload-content" })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("private-upload-content")
  }
  expect(network).not.toHaveBeenCalled()
})

test.each([200, 301, 401, 403, 404, 422, 429, 500])("preserves upstream error HTTP %s, redacts credentials and keeps uploads out of logs", async status => {
  const raw = '{"error":{"message":"fixture-copilot-token synthetic-image-output"}}'
  network.mockResolvedValueOnce(new Response(raw, { status, headers: { "content-type": "application/json", location: "https://other.invalid" } }))
  const response = await request()
  expect(response.status).toBe(status)
  expect(await response.text()).toContain("synthetic-image-output")
  expect(response.headers.get("location")).toBeNull()
  expect(JSON.stringify(events)).not.toContain("fixture-copilot-token")
  expect(JSON.stringify(events)).not.toContain("synthetic-image-output")
  expect(events.find(event => event.type === "request_end")?.data).toMatchObject({ status: "error", statusCode: status })
  expect(network).toHaveBeenCalledTimes(1)
})

test("transport failure and cancellation do not retry or leak credentials", async () => {
  network.mockRejectedValueOnce(new Error("fixture-copilot-token"))
  const failure = await request()
  expect(failure.status).toBe(502)
  expect(await failure.text()).not.toContain("fixture-copilot-token")
  const controller = new AbortController()
  network.mockImplementationOnce((_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
    controller.abort()
  }))
  expect((await request(form(), "fixture-client", controller.signal)).status).toBe(499)
  expect(network).toHaveBeenCalledTimes(2)
})
