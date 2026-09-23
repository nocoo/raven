import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { COPILOT_UPSTREAM_ID, type UpstreamDiagnostic } from "../../src/core/routing-types"
import { createRoutingRule } from "../../src/db/routing-rules"
import { getQuotaStatus } from "../../src/db/quota"
import { getProviderRecord, updateProvider } from "../../src/db/providers"
import { replaceCatalog } from "../../src/db/catalog"
import { startRequestSink } from "../../src/db/request-sink"
import { queryRequests } from "../../src/db/requests"
import { state } from "../../src/lib/state"
import { ruleInput, quotaPolicy, NOW } from "../db/routing-fixture"
import { chatResponse, jsonResponse, messageResponse, responsesResponse, routingHarness } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
let saved: typeof state
let network: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  h = routingHarness(); saved = { ...state }
  state.copilotToken = "fixture-copilot-token"
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"))
})
afterEach(() => { h.close(); Object.assign(state, saved); vi.restoreAllMocks() })

test("CRUD only saves configuration and exposes safe cached status", async () => {
  const created = await h.request("/api/upstreams", { name: "Custom", format: "responses", base_url: "https://fixture.invalid/v1", api_key: "fixture-long-secret", manual_models: ["manual"] })
  expect(created.status).toBe(201)
  const body = await created.json() as { id: string; api_key?: string }
  expect(body.api_key).toBeUndefined()
  expect((await h.request(`/api/upstreams/${body.id}`, { name: "Renamed" }, "PUT")).status).toBe(200)
  expect(await (await h.request(`/api/upstreams/${body.id}`)).json()).toMatchObject({ name: "Renamed", models: [], manual_models: ["manual"], last_refreshed_at: null })
  expect((await (await h.request("/api/upstreams")).json() as unknown[])).toHaveLength(2)
  expect((await h.request(`/api/upstreams/${body.id}`, undefined, "DELETE")).status).toBe(200)
  expect((await h.request(`/api/upstreams/${body.id}`)).status).toBe(404)
  expect(network).not.toHaveBeenCalled()
})

test("referenced and built-in upstream deletion returns explicit references", async () => {
  const up = h.upstream()
  const rule = createRoutingRule(h.db, ruleInput({ default_chain: [{ upstream_id: up.id, model: "raw" }] }))
  const response = await h.request(`/api/upstreams/${up.id}`, undefined, "DELETE")
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { type: "reference_conflict", references: [{ id: rule.id }] } })
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}`, undefined, "DELETE")).status).toBe(409)
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}`, { is_enabled: false }, "PUT")).status).toBe(409)
})

test("removed pattern payloads and malformed mutations are rejected locally", async () => {
  expect((await h.request("/api/upstreams", { name: "Old", format: "openai", model_patterns: ["*"] })).status).toBe(400)
  const bad = await h.app.request("/api/upstreams", { method: "POST", headers: { Authorization: "Bearer fixture-internal", "Content-Type": "application/json" }, body: "{" })
  expect(bad.status).toBe(400)
  expect((await h.request("/api/upstreams/missing", { name: "Missing" }, "PUT")).status).toBe(404)
  expect((await h.request("/api/upstreams/missing", undefined, "DELETE")).status).toBe(404)
  expect(network).not.toHaveBeenCalled()
})

test("migration summary is a safe entity and old live health GET is removed", async () => {
  expect((await h.request("/api/upstreams/migration")).status).toBe(200)
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/models`)).status).toBe(404)
  expect(network).not.toHaveBeenCalled()
})

test("refresh POST returns the enriched provider and preserves manually entered models", async () => {
  const up = h.upstream({ manual_models: ["manual"] })
  network.mockResolvedValueOnce(jsonResponse({ data: [{ id: "discovered", context_window: 100 }] }))
  const response = await h.request(`/api/upstreams/${up.id}/models/refresh`, {})
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ id: up.id, models: [{ id: "discovered", context_window: 100 }], manual_models: ["manual"], quota_status: { healthy: true } })
  expect(network).toHaveBeenCalledTimes(1)
  expect((await h.request("/api/upstreams/missing/models/refresh", {})).status).toBe(404)
})

test("refresh accepts slug-based catalogs and preserves raw IDs, metadata and manual models", async () => {
  const up = h.upstream({ manual_models: ["manual"] })
  const models = [
    { slug: "glm-5.3", display_name: "GLM 5.3", context_window: 1048576, supported_reasoning_levels: [{ effort: "max", description: "Deep reasoning" }] },
    { slug: "glm-5.3-flash", input_modalities: ["text", "image"] },
    { slug: "glm-5-turbo", supported_reasoning_levels: [] },
  ]
  network.mockResolvedValueOnce(jsonResponse({ models: [...models, { slug: "glm-5.3", display_name: "Duplicate" }] }))
  const response = await h.request(`/api/upstreams/${up.id}/models/refresh`, {})
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    models: models.map(model => ({ ...model, id: model.slug })), manual_models: ["manual"], last_refresh_error: null,
  })
  expect(getProviderRecord(h.db, up.id)?.models).toEqual(models.map(model => ({ ...model, id: model.slug })))
  expect(network).toHaveBeenCalledTimes(1)
})

test.each([
  ["chat_completions", "openai", chatResponse()],
  ["anthropic_messages", "anthropic", messageResponse()],
  ["responses", "responses", responsesResponse()],
] as const)("the %s diagnostic sends one native bounded request and records usage", async (format, protocol, answer) => {
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  const up = h.upstream({ format, quota: quotaPolicy() })
  const stop = startRequestSink(h.db)
  try {
    network.mockResolvedValueOnce(jsonResponse(answer))
    const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, model: "chosen-model", protocol, answer: "pong", expected_pong: true })
    expect(network).toHaveBeenCalledTimes(1)
    const wire = JSON.parse(network.mock.calls[0]![1].body)
    expect(wire.stream).toBe(false)
    expect(wire.model).toBe("chosen-model")
    expect(getQuotaStatus(h.db, up.id, NOW).used_tokens).toBe(12)
    expect(queryRequests(h.db).data[0]?.routing).toMatchObject({ upstream_id: up.id, diagnostic: true, weighted_tokens: 12 })
  } finally { stop() }
})

test.each([401, 400, 500])("Copilot test stops at its first HTTP %s including credential and effort failures", async (status) => {
  h.copilot([{ id: "claude-sonnet-4", supported_endpoints: ["/v1/messages"] }])
  network.mockResolvedValueOnce(jsonResponse({ error: { message: "token expired; reasoning_effort xhigh is not supported" } }, status))
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, { model: "claude-sonnet-4" })).status).toBe(status)
  expect(network).toHaveBeenCalledTimes(1)
})

test.each([
  ["responses", { output_text: "pong", status: "completed" }, "pong"],
  ["responses", null, ""],
  ["responses", { output: null, status: "incomplete" }, ""],
  ["responses", { output: [null, { type: "message", content: [{ type: "output_text", text: 42 }, { type: "output_text", text: "pong" }] }] }, "pong"],
  ["chat_completions", { ...chatResponse(), choices: null }, ""],
  ["chat_completions", { ...chatResponse(), choices: [{ message: { content: [null, { type: "image_url", image_url: "https://fixture.invalid/image" }, { type: "text", text: "pong" }] } }] }, "pong"],
] as const)("%s reply variants remain inspectable when text fields are sparse", async (format, body, answer) => {
  const up = h.upstream({ format })
  network.mockResolvedValueOnce(jsonResponse(body))
  const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
  const result = await response.json() as UpstreamDiagnostic
  expect(response.status).toBe(200)
  expect(result).toMatchObject({ answer, expected_pong: answer === "pong", answer_truncated: false })
  expect(JSON.parse(result.details.response_body!)).toEqual(body)
  expect(network).toHaveBeenCalledTimes(1)
})

test("native diagnostics reject a catalog alias that resolves to a different protocol without sending", async () => {
  h.copilot([
    { id: "claude-sonnet-4-5", supported_endpoints: ["/messages"] },
    { id: "claude-sonnet-4.5", supported_endpoints: ["/chat/completions"] },
  ])
  const response = await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, { model: "claude-sonnet-4-5" })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { type: "protocol_mismatch", details: { operation: "generation_test", request_id: expect.any(String) } } })
  expect(network).not.toHaveBeenCalled()
})

test("transport failures expose safe operation context even when the rejection is not an Error", async () => {
  const up = h.upstream()
  network.mockRejectedValueOnce(`Fixture socket failure with ${up.api_key}`)
  const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
  const result = await response.json()
  expect(response.status).toBe(500)
  expect(result).toMatchObject({ error: { type: "diagnostic_failed", message: "Fixture socket failure with [REDACTED]", details: { operation: "generation_test", url: "https://upstream.invalid/v1/chat/completions" } } })
  expect(result.error.details.upstream_status).toBeUndefined()
  expect(network).toHaveBeenCalledTimes(1)
})

test("a successful unexpected diagnostic answer is separate from catalog refresh state", async () => {
  const up = h.upstream()
  network.mockResolvedValueOnce(jsonResponse(chatResponse("chosen-model", "hello")))
  const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
  expect(await response.json()).toMatchObject({ success: true, expected_pong: false, answer: "hello" })
  expect(getProviderRecord(h.db, up.id)?.last_refreshed_at).toBeNull()
})

test("diagnostics reject missing models, unknown capabilities, disabled targets and exhausted quotas locally", async () => {
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, {})).status).toBe(400)
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, { model: "auto" })).status).toBe(400)
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, { model: " " })).status).toBe(400)
  expect((await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, { model: "uncached" })).status).toBe(503)
  expect((await h.request("/api/upstreams/missing/test", { model: "x" })).status).toBe(404)
  const up = h.upstream({ is_enabled: false })
  expect((await h.request(`/api/upstreams/${up.id}/test`, { model: "x" })).status).toBe(503)
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  updateProvider(h.db, up.id, { is_enabled: true, quota: quotaPolicy() })
  h.db.query("UPDATE quota_windows SET charged = 100 WHERE upstream_id = ?").run(up.id)
  expect((await h.request(`/api/upstreams/${up.id}/test`, { model: "x" })).status).toBe(429)
  expect(network).not.toHaveBeenCalled()
})

test("a reasoning-only Responses result exposes its incomplete native body and correlated request ID", async () => {
  const up = h.upstream({ format: "responses" })
  const native = {
    ...responsesResponse(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Considering the reply" }] }],
  }
  const stop = startRequestSink(h.db)
  try {
    network.mockResolvedValueOnce(jsonResponse(native))
    const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
    const result = await response.json() as UpstreamDiagnostic
    expect(response.status).toBe(200)
    expect(result).toMatchObject({ success: true, answer: "", answer_truncated: false, expected_pong: false, details: {
      operation: "generation_test", method: "POST", url: "https://upstream.invalid/v1/responses", upstream_status: 200,
      content_type: "application/json", finish_reason: "max_output_tokens", response_status: "incomplete", response_body_truncated: false,
    } })
    expect(JSON.parse(result.details.response_body!)).toEqual(native)
    expect(queryRequests(h.db).data[0]?.id).toBe(result.details.request_id)
    expect(JSON.parse(network.mock.calls[0]![1].body)).toMatchObject({ stream: false, max_output_tokens: 32 })
    expect(network).toHaveBeenCalledTimes(1)
  } finally { stop() }
})

test.each([
  ["chat_completions", { ...chatResponse(), choices: [{ message: { role: "assistant", content: null, reasoning_content: "Thinking" }, finish_reason: "length" }] }, "length"],
  ["anthropic_messages", { ...messageResponse(), content: [{ type: "thinking", thinking: "Thinking" }], stop_reason: "max_tokens" }, "max_tokens"],
] as const)("%s diagnostics retain non-text output without inventing an answer", async (format, body, reason) => {
  const up = h.upstream({ format })
  network.mockResolvedValueOnce(jsonResponse(body))
  const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
  const result = await response.json() as UpstreamDiagnostic
  expect(response.status).toBe(200)
  expect(result).toMatchObject({ success: true, answer: "", expected_pong: false, answer_truncated: false, details: { finish_reason: reason } })
  expect(JSON.parse(result.details.response_body!)).toEqual(body)
  expect(network).toHaveBeenCalledTimes(1)
})

test("diagnostic answer and native evidence are redacted before independent length bounds", async () => {
  const up = h.upstream()
  const answer = `${"x".repeat(1010)}${up.api_key}${"y".repeat(9000)}`
  network.mockResolvedValueOnce(jsonResponse(chatResponse("chosen-model", answer)))
  const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
  const result = await response.json() as UpstreamDiagnostic
  expect(result).toMatchObject({ expected_pong: false, answer_truncated: true, details: { response_body_truncated: true } })
  expect(result.answer).toHaveLength(1024)
  expect(result.answer).toContain("[REDACTED]")
  expect(result.details.response_body).toHaveLength(8192)
  expect(JSON.stringify(result)).not.toContain(up.api_key)
  expect(network).toHaveBeenCalledTimes(1)
})

test("HTTP test failures preserve actionable evidence while redacting actual Copilot credentials", async () => {
  h.copilot([{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }])
  network.mockResolvedValueOnce(jsonResponse({ error: { message: `Token ${state.copilotToken} rejected`, authorization: `Bearer ${state.copilotToken}`, api_key: "fixture-echoed-key" } }, 401))
  const response = await h.request(`/api/upstreams/${COPILOT_UPSTREAM_ID}/test`, { model: "gpt-5.6-sol" })
  const result = await response.json()
  expect(response.status).toBe(401)
  expect(result).toMatchObject({ error: { type: "diagnostic_failed", details: {
    operation: "generation_test", method: "POST", upstream_status: 401, content_type: "application/json", request_id: expect.any(String),
  } } })
  expect(result.error.details.response_body).toContain("[REDACTED]")
  expect(JSON.stringify(result)).not.toContain(state.copilotToken)
  expect(JSON.stringify(result)).not.toContain("fixture-echoed-key")
  expect(network).toHaveBeenCalledTimes(1)
})

test("upstream malformed JSON remains an upstream diagnostic error with the original response evidence", async () => {
  const up = h.upstream({ format: "responses" })
  network.mockResolvedValueOnce(new Response(`<html>unexpected gateway response; api_key="${up.api_key}"</html>`, { headers: { "content-type": "text/html" } }))
  const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
  expect(response.status).toBe(502)
  const result = await response.json()
  expect(result).toMatchObject({ error: { type: "diagnostic_failed", message: "The upstream diagnostic did not return valid JSON", details: {
    upstream_status: 200, content_type: "text/html", response_body: expect.stringContaining("unexpected gateway response"),
  } } })
  expect(JSON.stringify(result)).not.toContain(up.api_key)
  expect(network).toHaveBeenCalledTimes(1)
})

test.each(["chat_completions", "anthropic_messages", "responses"] as const)("%s test cancels a held-open native SSE response promptly without replay", async (format) => {
  const up = h.upstream({ format })
  const cancel = vi.fn()
  const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
  network.mockResolvedValueOnce(new Response(source, { headers: { "content-type": "text/event-stream" } }))
  const response = await h.request(`/api/upstreams/${up.id}/test`, { model: "chosen-model" })
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ error: {
    type: "diagnostic_failed", message: "The diagnostic returned an unexpected stream",
    details: { operation: "generation_test", upstream_status: 200, content_type: "text/event-stream", request_id: expect.any(String) },
  } })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(network).toHaveBeenCalledTimes(1)
  expect(JSON.parse(network.mock.calls[0]![1].body)).toMatchObject({ stream: false, model: "chosen-model" })
  expect(getProviderRecord(h.db, up.id)?.last_refreshed_at).toBeNull()
}, 1000)

test("catalog refresh cancels an unexpected held-open event stream and retains its cache", async () => {
  const up = h.upstream()
  replaceCatalog(h.db, up.id, [{ id: "old-cache" }], 123)
  const cancel = vi.fn()
  network.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }))
  const response = await h.request(`/api/upstreams/${up.id}/models/refresh`, {})
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: {
    type: "catalog_refresh_failed", message: "Model discovery returned an unexpected stream",
    details: { operation: "model_discovery", upstream_status: 200, content_type: "text/event-stream" },
  } })
  expect(getProviderRecord(h.db, up.id)).toMatchObject({ models: [{ id: "old-cache" }], last_refreshed_at: 123 })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(network).toHaveBeenCalledTimes(1)
}, 1000)

test.each([
  [401, "application/json", '{"error":{"message":"Invalid credential","api_key":"fixture-secret"}}', "Model discovery returned HTTP 401"],
  [200, "text/html", "<html>Gateway login required</html>", "Model discovery did not return valid JSON"],
  [200, "application/json", '{"models":{}}', "Model discovery did not return a data or models array"],
  [200, "application/json", '{}', "Model discovery did not return a data or models array"],
  [200, "application/json", '{"models":["alternative-schema"]}', "Model discovery returned an invalid model ID"],
  [200, "application/json", '{"models":[{"slug":"valid"},{"slug":" "}]}', "Model discovery returned an invalid model ID"],
  [200, "application/json", '{"data":null,"models":[{"slug":"valid"}]}', "Model discovery did not return a data or models array"],
  [200, "application/json", '{"data":[{"id":null}]}', "Model discovery returned an invalid model ID"],
] as const)("discovery failure (%s, %s) returns details and retains the good cache", async (status, contentType, body, message) => {
  const up = h.upstream()
  replaceCatalog(h.db, up.id, [{ id: "old-cache" }], 123)
  network.mockResolvedValueOnce(new Response(body, { status, headers: { "content-type": contentType, "x-request-id": "fixture-upstream-request" } }))
  const response = await h.request(`/api/upstreams/${up.id}/models/refresh`, {})
  const result = await response.json()
  expect(response.status).toBe(503)
  expect(result).toMatchObject({ error: { type: "catalog_refresh_failed", message, details: {
    operation: "model_discovery", method: "GET", url: "https://upstream.invalid/v1/models", upstream_status: status,
    content_type: contentType, request_id: "fixture-upstream-request", response_body_truncated: false,
  } } })
  expect(result.error.details.response_body).toBeTruthy()
  expect(JSON.stringify(result)).not.toContain(up.api_key)
  expect(getProviderRecord(h.db, up.id)).toMatchObject({ models: [{ id: "old-cache" }], last_refreshed_at: 123, last_refresh_error: status >= 400 ? `Model catalog refresh failed (HTTP ${status})` : "Model catalog refresh failed" })
  expect(network).toHaveBeenCalledTimes(1)
})
