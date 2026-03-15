import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { createMessagesRoute } from "../../src/routes/messages.ts";
import type { CopilotClient } from "../../src/copilot/client.ts";
import type { AnthropicRequest } from "../../src/translate/types.ts";

// ---------------------------------------------------------------------------
// Helper: create a mock Copilot client
// ---------------------------------------------------------------------------
function createMockClient(
  responseBody: unknown,
  options: { stream?: boolean; status?: number } = {},
): CopilotClient {
  return {
    chatCompletion: mock(async () => {
      if (options.stream) {
        // Return SSE stream
        const body = responseBody as string;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        });
        return new Response(stream, {
          status: options.status ?? 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(responseBody), {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
    fetchModels: mock(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    createEmbedding: mock(async () => {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Helper: minimal Anthropic request body
// ---------------------------------------------------------------------------
function makeAnthropicBody(
  overrides: Partial<AnthropicRequest> = {},
): AnthropicRequest {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: make app with mock client and JWT
// ---------------------------------------------------------------------------
function makeApp(client: CopilotClient) {
  const app = new Hono();
  app.route("/v1", createMessagesRoute(client, "mock-jwt-token"));
  return app;
}

// ===========================================================================
// Non-streaming
// ===========================================================================

describe("POST /v1/messages (non-streaming)", () => {
  test("translates request and returns Anthropic response", async () => {
    const openAIResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1700000000,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi there!" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    const client = createMockClient(openAIResponse);
    const app = makeApp(client);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeAnthropicBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Anthropic response format
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toEqual([{ type: "text", text: "Hi there!" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.input_tokens).toBe(10);
    expect(body.usage.output_tokens).toBe(5);
  });

  test("forwards translated request to copilot client", async () => {
    const openAIResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1700000000,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };

    const client = createMockClient(openAIResponse);
    const app = makeApp(client);

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        makeAnthropicBody({
          model: "claude-sonnet-4-20250514",
          system: "Be helpful",
        }),
      ),
    });

    // Verify the client was called with translated OpenAI format
    const fn = client.chatCompletion as ReturnType<typeof mock>;
    expect(fn).toHaveBeenCalledTimes(1);
    const [request, jwt] = fn.mock.calls[0] as [Record<string, unknown>, string];
    expect(jwt).toBe("mock-jwt-token");
    // Model should be normalized
    expect(request.model).toBe("claude-sonnet-4");
    // Should have system message
    expect(
      (request.messages as Array<{ role: string }>)[0].role,
    ).toBe("system");
  });

  test("with tool_calls response → tool_use blocks", async () => {
    const openAIResponse = {
      id: "chatcmpl-456",
      object: "chat.completion",
      created: 1700000000,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"SF"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    };

    const client = createMockClient(openAIResponse);
    const app = makeApp(client);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeAnthropicBody()),
    });

    const body = await res.json();
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content[0]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
    });
  });

  test("upstream error → forwards status code", async () => {
    const client = createMockClient(
      { error: { message: "rate limited" } },
      { status: 429 },
    );
    const app = makeApp(client);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeAnthropicBody()),
    });

    expect(res.status).toBe(429);
  });
});

// ===========================================================================
// Streaming
// ===========================================================================

describe("POST /v1/messages (streaming)", () => {
  test("streams Anthropic SSE events", async () => {
    // Simulate OpenAI SSE response
    const sseBody = [
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "claude-sonnet-4",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { content: "Hello!" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "claude-sonnet-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    const client = createMockClient(sseBody, { stream: true });
    const app = makeApp(client);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeAnthropicBody({ stream: true })),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    // Should contain Anthropic SSE events
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: content_block_stop");
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
  });

  test("stream request sets stream:true on copilot request", async () => {
    const sseBody =
      `data: ${JSON.stringify({
        id: "id",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      })}\n\n` +
      `data: ${JSON.stringify({
        id: "id",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n` +
      "data: [DONE]\n\n";

    const client = createMockClient(sseBody, { stream: true });
    const app = makeApp(client);

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeAnthropicBody({ stream: true })),
    });

    const fn = client.chatCompletion as ReturnType<typeof mock>;
    const [request] = fn.mock.calls[0] as [Record<string, unknown>];
    expect(request.stream).toBe(true);
  });
});
