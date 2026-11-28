import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";

import type { CreateProviderInput } from "../../src/core/routing-types";
import * as tavilyModule from "../../src/lib/server-tools/tavily";
import { state } from "../../src/lib/state";
import { handleCompletion } from "../../src/routes/messages/handler";
import * as copilotOpenAIModule from "../../src/upstream/copilot-openai";
import { logEmitter } from "../../src/util/log-emitter";
import type { LogEvent } from "../../src/util/log-event";
import type { ServerSentEvent } from "../../src/util/sse";
import { installTestRouting, routingHarness } from "../helpers/routing";

function makeApp(): Hono {
  const app = new Hono();
  installTestRouting(app, harness.db);
  app.post("/v1/messages", handleCompletion);
  return app;
}

function selectUpstream(
  overrides: Pick<CreateProviderInput, "name" | "base_url" | "format" | "api_key"> &
    Partial<CreateProviderInput>,
): void {
  harness.bind(
    harness.upstream({
      is_enabled: true,
      supports_reasoning: false,
      auth_style: null,
      use_socks5: null,
      ...overrides,
    }).id,
  );
}

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockFetchJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetchStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function mockFetchErroringStream(chunks: string[], error: Error): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.error(error);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseLine(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function makeChunk(
  delta: Record<string, unknown>,
  opts: {
    model?: string;
    finishReason?: string | null;
    usage?: Record<string, unknown> | null;
  } = {},
): string {
  return sseLine({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: opts.model ?? "claude-sonnet-4",
    choices: [{ index: 0, delta, finish_reason: opts.finishReason ?? null, logprobs: null }],
    system_fingerprint: null,
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  });
}

function makeOpenAIResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...overrides,
  };
}

function createMockStream(content: string): AsyncGenerator<ServerSentEvent> {
  const events: ServerSentEvent[] = [
    {
      data: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: null, tool_calls: [] },
            finish_reason: null,
            logprobs: null,
          },
        ],
        system_fingerprint: null,
        usage: null,
      }),
      event: null,
      id: null,
      retry: null,
    },
    {
      data: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            delta: { content, role: null, tool_calls: [] },
            finish_reason: null,
            logprobs: null,
          },
        ],
        system_fingerprint: null,
        usage: null,
      }),
      event: null,
      id: null,
      retry: null,
    },
    {
      data: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "claude-sonnet-4-20250514",
        choices: [
          {
            index: 0,
            delta: { content: null, role: null, tool_calls: [] },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        system_fingerprint: null,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
      event: null,
      id: null,
      retry: null,
    },
    { data: "[DONE]", event: null, id: null, retry: null },
  ];

  return (async function* () {
    for (const chunk of events) yield chunk;
  })();
}

async function captureLogs<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; events: LogEvent[] }> {
  const events: LogEvent[] = [];
  const listener = (e: LogEvent) => events.push(e);
  logEmitter.on("log", listener);
  try {
    const result = await fn();
    return { result, events };
  } finally {
    logEmitter.off("log", listener);
  }
}

const savedModels = state.models;
const savedToken = state.copilotToken;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let harness: ReturnType<typeof routingHarness>;

beforeEach(() => {
  harness = routingHarness();
  state.stWebSearchEnabled = false;
  state.stWebSearchApiKey = null;
  state.copilotToken = "test-token";
  state.vsCodeVersion = "1.90.0";
  state.accountType = "individual";
  state.models = null;
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  state.models = savedModels !== undefined ? savedModels : null;
  state.copilotToken = savedToken !== undefined ? savedToken : null;
  fetchSpy.mockRestore();
  harness.close();
});

describe("messages handler (non-streaming)", () => {
  test("translates Anthropic request → OpenAI → Anthropic response", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()));

    const res = await makeApp().request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.stop_reason).toBe("end_turn");
    expect(Array.isArray(json.content)).toBe(true);
  });

  test("emits request_start with messageCount/toolCount and request_end with translatedModel & cached usage", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchJson(
        makeOpenAIResponse({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      ),
    );

    const { events } = await captureLogs(() =>
      makeApp().request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
          tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        }),
      ),
    );

    const startEvent = events.find((e) => e.type === "request_start");
    expect(startEvent?.data).toMatchObject({
      messageCount: 2,
      toolCount: 1,
      format: "anthropic",
    });

    const endEvent = events.find((e) => e.type === "request_end");
    expect(endEvent?.data).toMatchObject({
      translatedModel: "claude-sonnet-4",
      format: "anthropic",
      inputTokens: 60,
      outputTokens: 20,
    });
  });
});

describe("messages handler (streaming)", () => {
  test("translates OpenAI stream chunks to Anthropic SSE and ignores trailing data after [DONE]", async () => {
    const chunk = makeChunk({ role: "assistant", content: "Hi" });
    fetchSpy.mockResolvedValueOnce(mockFetchStream([chunk, "data: [DONE]\n\n", chunk]));

    const res = await makeApp().request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("message_start");
  });

  test("skips empty data chunks", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchStream(["\n\n", "data: [DONE]\n\n"]));

    const res = await makeApp().request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    await res.text();
    expect(res.status).toBe(200);
  });

  test("extracts usage from stream and logs in request_end", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        makeChunk({ content: "Hi" }, { model: "claude-sonnet-4-resolved" }),
        sseLine({
          id: "c1",
          model: "claude-sonnet-4-resolved",
          choices: [],
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        }),
        "data: [DONE]\n\n",
      ]),
    );

    const { events } = await captureLogs(async () => {
      const res = await makeApp().request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      );
      await res.text();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(events.find((e) => e.type === "request_end")?.data).toMatchObject({
      resolvedModel: "claude-sonnet-4-resolved",
      inputTokens: 50,
      outputTokens: 10,
    });
  });
});

describe("messages handler (errors)", () => {
  test("upstream error → emits request_end with error status", async () => {
    fetchSpy.mockRejectedValueOnce(
      Object.assign(new TypeError("upstream failed"), { code: "ECONNRESET" }),
    );

    const app = makeApp();
    app.onError((err, c) => c.json({ error: (err as Error).message }, 502));

    const { events } = await captureLogs(() =>
      app.request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    );

    expect(events.find((e) => e.type === "request_end")?.data).toMatchObject({
      status: "error",
      statusCode: 502,
    });
  });

  test("stream error → sends Anthropic error event", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchErroringStream([makeChunk({ content: "Hi" })], new Error("connection reset")),
    );

    const { result: text, events } = await captureLogs(async () => {
      const res = await makeApp().request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      const body = await res.text();
      await new Promise((r) => setTimeout(r, 50));
      return body;
    });

    expect(text).toContain("error");
    const endEvent = events.find((e) => e.type === "request_end");
    expect(endEvent?.data?.status).toBe("error");
    expect(endEvent?.data?.error).toContain("stream error");
  });
});

describe("messages handler (thinking drop & optToolCallDebug logs)", () => {
  let savedOptToolCallDebug: boolean;

  beforeEach(() => {
    savedOptToolCallDebug = state.optToolCallDebug;
  });

  afterEach(() => {
    state.optToolCallDebug = savedOptToolCallDebug;
  });

  test("emits thinking drop debug log only when thinking is present on Copilot path", async () => {
    fetchSpy.mockResolvedValue(mockFetchJson(makeOpenAIResponse()));

    const withThinking = await captureLogs(() =>
      makeApp().request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "enabled", budget_tokens: 10000 },
        }),
      ),
    );
    const thinkingDebug = withThinking.events.find(
      (e) => e.level === "debug" && e.msg.includes("thinking parameter dropped"),
    );
    expect(thinkingDebug?.msg).toContain("Copilot does not support");
    expect(thinkingDebug?.data?.budgetTokens).toBe(10000);
    expect(thinkingDebug?.data?.hint).toContain("Anthropic provider");

    const withoutThinking = await captureLogs(() =>
      makeApp().request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    );
    expect(
      withoutThinking.events.find(
        (e) => e.level === "debug" && e.msg.includes("thinking parameter dropped"),
      ),
    ).toBeUndefined();
  });

  test("emits tool definitions and server-tool debug logs only when optToolCallDebug is true", async () => {
    fetchSpy.mockResolvedValue(mockFetchJson(makeOpenAIResponse()));

    state.optToolCallDebug = true;
    state.stWebSearchEnabled = true;
    state.stWebSearchApiKey = "tvly-test-key";

    const enabled = await captureLogs(() =>
      makeApp().request(
        req({
          model: "gpt-4o",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hi" }],
          tools: [
            { name: "get_weather", input_schema: { type: "object" } },
            { name: "web_search", type: "web_search_20260209", input_schema: { type: "object" } },
          ],
        }),
      ),
    );

    expect(
      enabled.events.find((e) => e.level === "debug" && e.msg.includes("tool definitions"))?.data,
    ).toMatchObject({ toolDefinitionCount: 2 });
    expect(
      enabled.events.find((e) => e.level === "debug" && e.msg.includes("server-tool check"))?.data,
    ).toMatchObject({ hasServerSideTools: true, webSearchEnabled: true });

    state.optToolCallDebug = false;
    const disabled = await captureLogs(() =>
      makeApp().request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        }),
      ),
    );
    expect(
      disabled.events.find((e) => e.level === "debug" && e.msg.includes("tool definitions")),
    ).toBeUndefined();
  });
});

describe("messages handler (custom providers)", () => {
  test("routes to OpenAI provider and translates request/response", async () => {
    selectUpstream({
      name: "test-openai",
      base_url: "https://api.example.com/v1",
      format: "chat_completions",
      api_key: "sk-test",
    });
    fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({ model: "my-model-v2" })));

    const res = await makeApp().request(
      req({
        model: "my-model-v2",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("https://api.example.com/v1");
  });

  test("routes to Anthropic provider and passthroughs request", async () => {
    selectUpstream({
      name: "test-anthropic",
      base_url: "https://api.anthropic.com",
      format: "anthropic_messages",
      api_key: "sk-ant-test",
    });
    fetchSpy.mockResolvedValueOnce(
      mockFetchJson({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-3-opus-20240229",
        content: [{ type: "text", text: "Hello from Anthropic!" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );

    const res = await makeApp().request(
      req({
        model: "claude-3-opus-20240229",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(json.model).toBe("claude-3-opus-20240229");
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("https://api.anthropic.com");
  });

  test.each([
    { supportsReasoning: false, model: "custom-model", expectDropLog: true },
    { supportsReasoning: true, model: "o1-preview", expectDropLog: false },
  ])(
    "OpenAI provider thinking drop log matches supports_reasoning=$supportsReasoning",
    async ({ supportsReasoning, model, expectDropLog }) => {
      selectUpstream({
        name: `test-openai-${supportsReasoning}`,
        base_url: "https://api.example.com/v1",
        format: "chat_completions",
        api_key: "sk-test",
        supports_reasoning: supportsReasoning,
      });
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse({ model })));

      const { events } = await captureLogs(() =>
        makeApp().request(
          req({
            model,
            max_tokens: 4096,
            messages: [{ role: "user", content: "hi" }],
            thinking: { type: "enabled", budget_tokens: 5000 },
          }),
        ),
      );

      const dropLog = events.find(
        (e) => e.level === "debug" && e.msg.includes("does not declare supports_reasoning"),
      );
      if (expectDropLog) {
        expect(dropLog?.data).toMatchObject({
          provider: `test-openai-${supportsReasoning}`,
          budgetTokens: 5000,
        });
      } else {
        expect(dropLog).toBeUndefined();
      }
    },
  );
});

describe("messages handler (tool_choice rewrite)", () => {
  let savedOptToolCallDebug: boolean;
  let savedStWebSearchEnabled: boolean;
  let savedStWebSearchApiKey: string | null;

  beforeEach(() => {
    savedOptToolCallDebug = state.optToolCallDebug;
    savedStWebSearchEnabled = state.stWebSearchEnabled;
    savedStWebSearchApiKey = state.stWebSearchApiKey;
  });

  afterEach(() => {
    state.optToolCallDebug = savedOptToolCallDebug;
    state.stWebSearchEnabled = savedStWebSearchEnabled;
    state.stWebSearchApiKey = savedStWebSearchApiKey;
  });

  test.each([
    { targetTool: "web_search", expectRewrite: true },
    { targetTool: "get_weather", expectRewrite: false },
  ])(
    "mixed-mode tool_choice for $targetTool (expectRewrite=$expectRewrite)",
    async ({ targetTool, expectRewrite }) => {
      state.stWebSearchEnabled = true;
      state.stWebSearchApiKey = "test-tavily-key";

      fetchSpy.mockResolvedValueOnce(
        mockFetchStream([
          makeChunk({ role: "assistant", content: "ok" }),
          makeChunk(
            {},
            {
              finishReason: "stop",
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            },
          ),
          "data: [DONE]\n\n",
        ]),
      );

      const { events } = await captureLogs(() =>
        makeApp().request(
          req({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            messages: [{ role: "user", content: "query" }],
            tools: [
              { name: "get_weather", input_schema: { type: "object" } },
              { name: "web_search", type: "web_search_20250305", input_schema: { type: "object" } },
            ],
            tool_choice: { type: "tool", name: targetTool },
          }),
        ),
      );

      const rewriteLog = events.find((e) => e.msg.includes("tool_choice rewritten"));
      if (expectRewrite) {
        expect(rewriteLog?.data).toMatchObject({
          originalToolChoice: "web_search",
          newToolChoice: "auto",
        });
      } else {
        expect(rewriteLog).toBeUndefined();
      }
    },
  );
});

describe("messages handler (streaming tool call debug & server-side tools)", () => {
  let savedOptToolCallDebug: boolean;
  let savedStWebSearchEnabled: boolean;
  let savedStWebSearchApiKey: string | null;

  beforeEach(() => {
    savedOptToolCallDebug = state.optToolCallDebug;
    savedStWebSearchEnabled = state.stWebSearchEnabled;
    savedStWebSearchApiKey = state.stWebSearchApiKey;
  });

  afterEach(() => {
    state.optToolCallDebug = savedOptToolCallDebug;
    state.stWebSearchEnabled = savedStWebSearchEnabled;
    state.stWebSearchApiKey = savedStWebSearchApiKey;
  });

  test("emits tool_use started debug log and toolCallCount/Names in request_end", async () => {
    state.optToolCallDebug = true;
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        makeChunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        }),
        makeChunk({
          tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
        }),
        makeChunk(
          { tool_calls: [{ index: 0, function: { arguments: 'ation":"NYC"}' } }] },
          {
            finishReason: "tool_calls",
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          },
        ),
        "data: [DONE]\n\n",
      ]),
    );

    const { events } = await captureLogs(async () => {
      const res = await makeApp().request(
        req({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          stream: true,
          messages: [{ role: "user", content: "what is the weather in NYC?" }],
          tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        }),
      );
      await res.text();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(
      events.find((e) => e.level === "debug" && e.msg.includes("tool_use started"))?.data,
    ).toMatchObject({ toolName: "get_weather", toolId: "call_123" });
    expect(events.find((e) => e.type === "request_end")?.data).toMatchObject({
      toolCallCount: 1,
      toolCallNames: ["get_weather"],
    });
  });

  test("returns pure server-side web_search response from array text content", async () => {
    state.stWebSearchEnabled = true;
    state.stWebSearchApiKey = "tvly-test-key";

    const searchSpy = vi.spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: [
        {
          type: "web_search_result",
          url: "https://example.com",
          title: "Example",
          encrypted_content: "ZXhhbXBsZQ==",
        },
      ],
      textContent: "Example result body",
    });
    const createSpy = vi
      .spyOn(copilotOpenAIModule.CopilotOpenAIClient.prototype, "send")
      .mockResolvedValueOnce(createMockStream("Synthesized answer"));

    const res = await makeApp().request(
      req({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: [{ type: "text", text: "search the docs" }] }],
        tools: [
          {
            name: "web_search",
            type: "web_search_20260209",
            description: "Search the web",
            input_schema: { type: "object" },
          },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      content: Array<Record<string, unknown>>;
      usage: { server_tool_use?: { web_search_requests: number } | null };
    };
    expect(searchSpy).toHaveBeenCalledWith(
      "tvly-test-key",
      { query: "search the docs" },
      expect.any(AbortSignal),
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(json.content[0]?.type).toBe("server_tool_use");
    expect(json.content[1]?.type).toBe("web_search_tool_result");
    expect(json.content[2]).toEqual({ type: "text", text: "Synthesized answer" });
    expect(json.usage.server_tool_use).toEqual({ web_search_requests: 1 });

    searchSpy.mockRestore();
    createSpy.mockRestore();
  });
});

describe("messages handler (custom provider streaming edge cases)", () => {
  let savedOptToolCallDebug: boolean;

  beforeEach(() => {
    savedOptToolCallDebug = state.optToolCallDebug;
  });

  afterEach(() => {
    state.optToolCallDebug = savedOptToolCallDebug;
  });

  test("Anthropic provider streaming handles data-only SSE events and usage metrics", async () => {
    selectUpstream({
      name: "anthropic-stream",
      base_url: "https://anthropic.example.com",
      format: "anthropic_messages",
      api_key: "sk-ant-test",
    });

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        'data: {"type":"message_start","message":{"id":"msg-1"}}\n\n',
        'data: {"type":"message_delta","usage":{"input_tokens":7,"output_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const { result, events } = await captureLogs(async () => {
      const res = await makeApp().request(
        req({
          model: "claude-provider-v1",
          max_tokens: 4096,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      );
      return { status: res.status, text: await res.text() };
    });

    expect(result.status).toBe(200);
    expect(result.text).toContain('data: {"type":"message_start","message":{"id":"msg-1"}}');
    expect(events.find((e) => e.type === "request_end")?.data).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  test.each([
    {
      format: "anthropic_messages" as const,
      name: "anthropic-stream",
      url: "https://anthropic.example.com",
      model: "claude-provider-v1",
      chunk: 'data: {"type":"message_start","message":{"id":"msg-1"}}\n\n',
      msg: "connection reset",
    },
    {
      format: "chat_completions" as const,
      name: "openai-stream",
      url: "https://openai.example.com",
      model: "gpt-provider-v1",
      chunk: 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      msg: "provider stream failed",
    },
  ])(
    "$format provider streaming emits Anthropic error event on mid-stream failure",
    async ({ format, name, url, model, chunk, msg }) => {
      selectUpstream({ name, base_url: url, format, api_key: "sk-test" });
      fetchSpy.mockResolvedValueOnce(mockFetchErroringStream([chunk], new Error(msg)));

      const { result: text, events } = await captureLogs(async () => {
        const res = await makeApp().request(
          req({
            model,
            max_tokens: 4096,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        );
        return res.text();
      });

      expect(text).toContain("event: error");
      const endEvent = events.find((e) => e.type === "request_end");
      expect(endEvent?.data?.status).toBe("error");
      expect(endEvent?.data?.error).toContain(`stream error: ${msg}`);
    },
  );

  test("OpenAI provider streaming records cached-token usage and tool-call debug data", async () => {
    selectUpstream({
      name: "openai-stream",
      base_url: "https://openai.example.com",
      format: "chat_completions",
      api_key: "sk-openai",
    });
    state.optToolCallDebug = true;

    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        makeChunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_provider",
                type: "function",
                function: { name: "calculator", arguments: "" },
              },
            ],
          },
          { model: "gpt-provider-upstream" },
        ),
        makeChunk(
          { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] },
          {
            model: "gpt-provider-upstream",
            finishReason: "tool_calls",
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
              prompt_tokens_details: { cached_tokens: 2 },
            },
          },
        ),
        "data: [DONE]\n\n",
      ]),
    );

    const { result: text, events } = await captureLogs(async () => {
      const res = await makeApp().request(
        req({
          model: "gpt-provider-v1",
          max_tokens: 4096,
          stream: true,
          messages: [{ role: "user", content: "calculate 1+1" }],
          tools: [{ name: "calculator", input_schema: { type: "object" } }],
        }),
      );
      const body = await res.text();
      await new Promise((r) => setTimeout(r, 50));
      return body;
    });

    expect(text).toContain("event: message_start");
    expect(
      events.find((e) => e.level === "debug" && e.msg.includes("tool_use started"))?.data?.toolName,
    ).toBe("calculator");
    expect(events.find((e) => e.type === "request_end")?.data).toMatchObject({
      resolvedModel: "gpt-provider-upstream",
      inputTokens: 10,
      outputTokens: 4,
      toolCallCount: 1,
      toolCallNames: ["calculator"],
    });
  });

  test("OpenAI provider logs and forwards fetch failures", async () => {
    selectUpstream({
      name: "openai-stream",
      base_url: "https://openai.example.com",
      format: "chat_completions",
      api_key: "sk-openai",
    });
    fetchSpy.mockRejectedValueOnce(new Error("provider unreachable"));

    const { result, events } = await captureLogs(async () => {
      const res = await makeApp().request(
        req({
          model: "gpt-provider-v1",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hello" }],
        }),
      );
      return { status: res.status, json: (await res.json()) as { error: { message: string } } };
    });

    expect(result.status).toBe(500);
    expect(result.json.error.message).toContain("provider unreachable");
    const endEvent = events.find((e) => e.type === "request_end");
    expect(endEvent?.data?.status).toBe("error");
    expect(endEvent?.data?.error).toContain("provider unreachable");
  });
});
