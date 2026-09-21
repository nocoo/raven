import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApiKey, deleteApiKey, initApiKeys, revokeApiKey, type ApiKeyCreated } from "../../src/db/keys";
import { compileProvider } from "../../src/db/providers";
import { initDatabase, KEY_ID_EXPR, queryBreakdown, queryRequests, querySummary } from "../../src/db/requests";
import { startRequestSink } from "../../src/db/request-sink";
import { state } from "../../src/lib/state";
import { apiKeyAuth } from "../../src/middleware";
import { handleCompletion } from "../../src/routes/chat-completions/handler";
import { createMessageRoutes } from "../../src/routes/messages/route";
import { handleResponses } from "../../src/routes/responses/handler";

vi.mock("../../src/lib/utils", async () => ({
  ...await vi.importActual<typeof import("../../src/lib/utils")>("../../src/lib/utils"),
  refreshModelsIfStale: vi.fn(),
}));

function model(id: string, endpoints: string[]) {
  return { id, name: id, object: "model", vendor: "fixture", version: "1", preview: false, policy: null, model_picker_enabled: true, supported_endpoints: endpoints, capabilities: { family: id, object: "model_capabilities", type: "chat", tokenizer: "o200k_base", supports: { tool_calls: true, parallel_tool_calls: true, dimensions: null }, limits: { max_context_window_tokens: 128000, max_output_tokens: 4096, max_prompt_tokens: null, max_inputs: null } } };
}

function provider(format: "anthropic" | "openai") {
  return compileProvider({ id: `provider-${format}`, name: format, format, base_url: `https://${format}.invalid`, api_key: "fixture-only", model_patterns: JSON.stringify([`custom-${format}`]), enabled: 1, created_at: 1, updated_at: 1, supports_reasoning: 0, supports_models_endpoint: 0, use_socks5: 0 })!;
}

const anthropicResponse = { id: "msg-fixture", type: "message", role: "assistant", model: "claude-monitor", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } };
const chatResponse = { id: "chat-fixture", object: "chat.completion", created: 1, model: "gpt-direct", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
const responsesResponse = { id: "resp-fixture", object: "response", model: "gpt-responses", status: "completed", created_at: 1, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };

let db: Database;
let stopSink: () => void;
let app: Hono;
let key: ApiKeyCreated;
let saved: typeof state;

beforeEach(() => {
  saved = { ...state };
  Object.assign(state, { copilotToken: "fixture-only", vsCodeVersion: "1.90.0", accountType: "individual", rateLimitSeconds: null, socks5Enabled: false, stWebSearchEnabled: false, optFilterWhitespaceChunks: false, providers: [provider("openai"), provider("anthropic")], models: { object: "list", data: [model("claude-monitor", ["/v1/messages"]), model("gpt-direct", ["/chat/completions"]), model("gpt-responses", ["/responses"])] } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith("/v1/messages")) return Response.json(anthropicResponse);
    if (url.endsWith("/chat/completions")) return Response.json(chatResponse);
    if (url.endsWith("/responses")) return Response.json(responsesResponse);
    if (url === "https://api.tavily.com/search") return Response.json({ query: "hi", results: [{ title: "Fixture", url: "https://result.invalid", content: "Fixture result", score: 1 }], response_time: 0.01 });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  db = new Database(":memory:");
  initDatabase(db);
  initApiKeys(db);
  key = createApiKey(db, "Editor");
  stopSink = startRequestSink(db);
  app = new Hono();
  app.use("*", apiKeyAuth({ db, envApiKey: "fixture-env" }));
  app.route("/v1/messages", createMessageRoutes());
  app.post("/v1/chat/completions", handleCompletion);
  app.post("/v1/responses", handleResponses);
});

afterEach(() => {
  stopSink();
  db.close();
  Object.assign(state, saved);
  vi.restoreAllMocks();
});

async function send(path: string, modelName: string, options: { token?: string; stream?: boolean; tools?: unknown[] } = {}) {
  const body = path.endsWith("/responses") ? { model: modelName, input: "hi" } : { model: modelName, max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
  const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": options.token ?? key.key }, body: JSON.stringify({ ...body, stream: options.stream ?? false, ...(options.tools ? { tools: options.tools } : {}) }) });
  await response.text();
  return response.status;
}

describe("authenticated requests retain key identity through the real handlers and database sink", () => {
  test.each([
    ["/v1/messages", "claude-monitor", "copilot-native", "native"],
    ["/v1/messages", "gpt-direct", "copilot-translated", "translated"],
    ["/v1/chat/completions", "gpt-direct", "copilot-openai-direct", "native"],
    ["/v1/responses", "gpt-responses", "copilot-responses", "native"],
    ["/v1/chat/completions", "gpt-responses", "copilot-chat-via-responses", "translated"],
    ["/v1/chat/completions", "custom-openai", "custom-openai", "native"],
    ["/v1/messages", "custom-openai", "custom-openai", "translated"],
    ["/v1/messages", "custom-anthropic", "custom-anthropic", "native"],
  ])("%s %s is persisted as %s / %s", async (path, modelName, strategy, mode) => {
    expect(await send(path, modelName)).toBe(200);
    const rows = queryRequests(db, {}).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ api_key_id: key.id, key_id: key.id, account_name: "Editor", strategy, protocol_mode: mode });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([["claude-monitor", "native"], ["gpt-direct", "translated"]])("server-tools %s keeps its caller without going through the Runner", async (modelName, mode) => {
    state.stWebSearchEnabled = true;
    state.stWebSearchApiKey = "fixture-only";
    expect(await send("/v1/messages", modelName, { tools: [{ type: "web_search_20250305", name: "web_search" }] })).toBe(200);
    expect(queryRequests(db, {}).data[0]).toMatchObject({ key_id: key.id, protocol_mode: mode, server_tools_used: 1, strategy: mode === "native" ? "copilot-native" : "copilot-translated", upstream_format: mode === "native" ? "anthropic" : "openai" });
  });

  test.each(["claude-monitor", "gpt-direct"])("stream completion retains the key for %s", async modelName => {
    const wire = modelName === "claude-monitor"
      ? `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: anthropicResponse })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
      : `data: ${JSON.stringify({ ...chatResponse, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    expect(await send("/v1/messages", modelName, { stream: true })).toBe(200);
    expect(queryRequests(db, {}).data[0]).toMatchObject({ key_id: key.id, api_key_id: key.id, stream: 1 });
  });

  test("router rejection records the caller but does not invent a native route", async () => {
    expect(await send("/v1/chat/completions", "custom-anthropic")).toBe(400);
    expect(queryRequests(db, {}).data[0]).toMatchObject({ key_id: key.id, protocol_mode: "unknown", status: "error" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("same-name keys remain distinct after revocation, deletion and name reuse", async () => {
    const second = createApiKey(db, "Editor");
    expect(await send("/v1/chat/completions", "gpt-direct")).toBe(200);
    expect(await send("/v1/chat/completions", "gpt-direct", { token: second.key })).toBe(200);
    revokeApiKey(db, key.id);
    expect(await send("/v1/chat/completions", "gpt-direct")).toBe(401);
    deleteApiKey(db, key.id);
    const replacement = createApiKey(db, "Editor");
    expect(await send("/v1/chat/completions", "gpt-direct", { token: replacement.key })).toBe(200);
    expect(queryBreakdown(db, { by: "key_id" }).map(entry => entry.key).sort()).toEqual([key.id, second.id, replacement.id].sort());
    expect(querySummary(db, "", [])).toMatchObject({ total_requests: 3, native_count: 3 });
  });

  test("the environment key has its own durable, non-secret identity", async () => {
    expect(await send("/v1/chat/completions", "gpt-direct", { token: "fixture-env" })).toBe(200);
    expect(queryRequests(db, {}).data[0]).toMatchObject({ key_id: "env:default", account_name: "env:default" });
  });

  test("key and time drilldowns use an index instead of scanning the request table", () => {
    const plan = db.query(`EXPLAIN QUERY PLAN SELECT id FROM requests WHERE ${KEY_ID_EXPR} = ? AND timestamp >= ? AND timestamp <= ?`).all(key.id, 0, Date.now()) as { detail: string }[];
    expect(plan.some(row => /SEARCH requests USING INDEX/.test(row.detail))).toBe(true);
    expect(plan.some(row => /SCAN requests/.test(row.detail))).toBe(false);
  });
});
