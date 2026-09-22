import type { Hono } from "hono"
import { createApp } from "../../src/app"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID, type CreateProviderInput, type RoutingRuleInput, type UpstreamRecord } from "../../src/core/routing-types"
import { initDatabase } from "../../src/db/requests"
import { createProvider, getProviderRecord } from "../../src/db/providers"
import { updateRoutingRule } from "../../src/db/routing-rules"
import { replaceCatalog } from "../../src/db/catalog"
import { routingFixture, ruleInput } from "../db/routing-fixture"

export function upstreamRecord(overrides: Partial<UpstreamRecord> = {}): UpstreamRecord {
  return {
    id: "fixture-upstream", name: "Fixture upstream", kind: "custom", format: "chat_completions",
    base_url: "https://upstream.invalid/v1", api_key: "fixture-secret", is_enabled: true,
    supports_reasoning: false, auth_style: null, use_socks5: null, manual_models: [], models: [],
    last_refreshed_at: null, last_refresh_error: null, quota: null, created_at: 1, updated_at: 1,
    ...overrides,
  }
}

export function installTestRouting(app: Hono, db: ReturnType<typeof routingFixture>["db"], ruleId = COPILOT_RULE_ID) {
  app.use("*", async (c, next) => {
    c.set("routingDb", db)
    c.set("ruleId", ruleId)
    c.set("admittedAt", Date.now())
    await next()
  })
}

export function routingHarness() {
  const fixture = routingFixture()
  const db = fixture.db
  initDatabase(db)
  const app = createApp({ db, githubToken: "fixture-github-token", apiKey: "fixture-client", internalKey: "fixture-internal" })
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token = "fixture-client") => app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    ...fixture, db, app, request,
    bind(upstreamId: string, model = "chosen-model", overrides: Partial<RoutingRuleInput> = {}) {
      return updateRoutingRule(db, COPILOT_RULE_ID, ruleInput({ allow_conversion: true, default_chain: [{ upstream_id: upstreamId, model }], ...overrides }))!
    },
    upstream(input: Partial<CreateProviderInput> = {}) {
      const provider = createProvider(db, { name: "Fixture upstream", format: "chat_completions", base_url: "https://upstream.invalid/v1", api_key: "fixture-secret", ...input })
      return getProviderRecord(db, provider.id)!
    },
    copilot(models: { id: string; supported_endpoints?: string[]; [key: string]: unknown }[]) {
      replaceCatalog(db, COPILOT_UPSTREAM_ID, models)
      return getProviderRecord(db, COPILOT_UPSTREAM_ID)!
    },
  }
}

export function chatResponse(model = "chosen-model", text = "pong") {
  return {
    id: "chat-fixture", object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } },
  }
}

export function messageResponse(model = "chosen-model", text = "pong") {
  return {
    id: "msg-fixture", type: "message", role: "assistant", model,
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, output_tokens: 2 },
  }
}

export function responsesResponse(model = "chosen-model", text = "pong") {
  return {
    id: "resp-fixture", object: "response", status: "completed", created_at: 1, model,
    output: [{ id: "msg-fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2, total_tokens: 12 },
  }
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

export function sseResponse(events: unknown[], protocol: "openai" | "anthropic" | "responses" = "openai") {
  const data = events.map((event) => typeof event === "string"
    ? `data: ${event}\n\n`
    : `${protocol === "openai" ? "" : `event: ${(event as { type: string }).type}\n`}data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(data, { headers: { "Content-Type": "text/event-stream" } })
}

export function generationEvents(protocol: "openai" | "anthropic" | "responses", model = "chosen-model") {
  if (protocol === "anthropic") return [
    { type: "message_start", message: { ...messageResponse(model), content: [], stop_reason: null, usage: { input_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]
  if (protocol === "responses") return [
    { type: "response.created", response: { ...responsesResponse(model), status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg-fixture", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg-fixture", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg-fixture", output_index: 0, content_index: 0, delta: "pong" },
    { type: "response.output_text.done", item_id: "msg-fixture", output_index: 0, content_index: 0, text: "pong" },
    { type: "response.completed", response: responsesResponse(model) },
  ]
  return [
    { id: "chat-fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] },
    { id: "chat-fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: chatResponse(model).usage },
    "[DONE]",
  ]
}
