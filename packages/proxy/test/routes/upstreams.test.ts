import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { COPILOT_UPSTREAM_ID } from "../../src/core/routing-types"
import { createRoutingRule } from "../../src/db/routing-rules"
import { getQuotaStatus } from "../../src/db/quota"
import { getProviderRecord, updateProvider } from "../../src/db/providers"
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
