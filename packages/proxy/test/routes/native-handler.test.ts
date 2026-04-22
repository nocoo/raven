import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"
import { state } from "../../src/lib/state"
import type { AnthropicMessagesPayload, AnthropicResponse } from "../../src/protocols/anthropic/types"
import * as tavilyModule from "../../src/lib/server-tools/tavily"

// We'll test the native handler through the main handleCompletion since handleCopilotNative
// imports createNativeMessages directly, and we need to mock at the fetch level.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: "hello" }],
    system: null,
    metadata: null,
    stop_sequences: null,
    stream: null,
    temperature: null,
    top_p: null,
    top_k: null,
    tools: null,
    tool_choice: null,
    thinking: null,
    service_tier: null,
    ...overrides,
  }
}

function mockAnthropicResponse(): AnthropicResponse {
  return {
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4",
    content: [{ type: "text", text: "Hello!" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      service_tier: null,
    },
  }
}

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function mockFetchStream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleCopilotNative integration", () => {
  let originalState: {
    copilotToken: typeof state.copilotToken
    vsCodeVersion: typeof state.vsCodeVersion
    accountType: typeof state.accountType
    stWebSearchEnabled: typeof state.stWebSearchEnabled
    stWebSearchApiKey: typeof state.stWebSearchApiKey
    models: typeof state.models
  }
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    originalState = {
      copilotToken: state.copilotToken,
      vsCodeVersion: state.vsCodeVersion,
      accountType: state.accountType,
      stWebSearchEnabled: state.stWebSearchEnabled,
      stWebSearchApiKey: state.stWebSearchApiKey,
      models: state.models,
    }
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.stWebSearchEnabled = false
    state.stWebSearchApiKey = null
    // Set up models cache with native support
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          object: "model",
          version: "2025-04-14",
          vendor: "anthropic",
          preview: false,
          model_picker_enabled: true,
          capabilities: {
            family: "claude",
            tokenizer: "cl100k_base",
            object: "model_capabilities",
            type: "chat",
            supports: {
              tool_calls: true,
              parallel_tool_calls: true,
              dimensions: null,
            },
            limits: {
              max_context_window_tokens: 200000,
              max_output_tokens: 8192,
              max_prompt_tokens: null,
              max_inputs: null,
            },
          },
          policy: null,
          supported_endpoints: ["/v1/messages", "/chat/completions"],
        },
      ],
    }
    fetchSpy = spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    state.copilotToken = originalState.copilotToken
    state.vsCodeVersion = originalState.vsCodeVersion
    state.accountType = originalState.accountType
    state.stWebSearchEnabled = originalState.stWebSearchEnabled
    state.stWebSearchApiKey = originalState.stWebSearchApiKey
    state.models = originalState.models
    fetchSpy.mockRestore()
  })

  test("routes to native path when model supports /v1/messages", async () => {
    // We can't easily test handleCopilotNative directly without creating
    // a full Hono context. Instead, test that it would be called by
    // checking the native path sends to /v1/messages endpoint.

    fetchSpy.mockResolvedValueOnce(mockFetchResponse(mockAnthropicResponse()))

    // Import handleCompletion lazily to get fresh module state
    const { handleCompletion } = await import("../../src/routes/messages/handler")

    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makePayload({ model: "claude-sonnet-4" })),
    })

    await app.request(req)

    // Should route to native /v1/messages endpoint
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.githubcopilot.com/v1/messages")
  })

  test("sends anthropic-version header on native path", async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(mockAnthropicResponse()))

    const { handleCompletion } = await import("../../src/routes/messages/handler")

    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makePayload({ model: "claude-sonnet-4" })),
    })

    await app.request(req)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("streams native response correctly", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchStream([
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-sonnet-4\",\"usage\":{\"input_tokens\":10}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello!\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ]),
    )

    const { handleCompletion } = await import("../../src/routes/messages/handler")

    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makePayload({ model: "claude-sonnet-4", stream: true })),
    })

    const res = await app.request(req)

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await res.text()
    expect(text).toContain("message_start")
    expect(text).toContain("Hello!")
  })

  test("falls back to translated path when model does not support native", async () => {
    // Model not in state.models - should fall back to translation
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          object: "model",
          version: "2024-08-06",
          vendor: "openai",
          preview: false,
          model_picker_enabled: true,
          capabilities: {
            family: "gpt",
            tokenizer: "cl100k_base",
            object: "model_capabilities",
            type: "chat",
            supports: {
              tool_calls: true,
              parallel_tool_calls: true,
              dimensions: null,
            },
            limits: {
              max_context_window_tokens: 128000,
              max_output_tokens: 4096,
              max_prompt_tokens: null,
              max_inputs: null,
            },
          },
          policy: null,
          // No supported_endpoints - model does not support native
        },
      ],
    }

    // Mock OpenAI response
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({
      id: "chatcmpl-123",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hi!", tool_calls: null },
        logprobs: null,
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))

    const { handleCompletion } = await import("../../src/routes/messages/handler")

    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makePayload({ model: "gpt-4o" })),
    })

    await app.request(req)

    // Should fall back to /chat/completions
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.githubcopilot.com/chat/completions")
  })

  test("retries with fallback effort when invalid_reasoning_effort error", async () => {
    // First request fails with invalid_reasoning_effort
    const errorResponse = {
      error: {
        code: "invalid_reasoning_effort",
        message: 'output_config.effort "max" is not supported by model claude-sonnet-4; supported values: [medium]',
      },
    }
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse(errorResponse, 400),
    )

    // Second request succeeds with fallback effort
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(mockAnthropicResponse()))

    const { handleCompletion } = await import("../../src/routes/messages/handler")

    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const payloadWithEffort = {
      ...makePayload({ model: "claude-sonnet-4" }),
      output_config: { effort: "max" },
    }

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadWithEffort),
    })

    const res = await app.request(req)

    expect(res.status).toBe(200)

    // Should have made two requests: first failed, second succeeded
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // Second request should have adjusted effort to "medium"
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
    const secondBody = JSON.parse(secondInit.body as string)
    expect(secondBody.output_config?.effort).toBe("medium")
  })
})

// ---------------------------------------------------------------------------
// H.7+H.8: server-tools branch (the surviving path in native-handler.ts)
// ---------------------------------------------------------------------------

describe("handleCopilotNativeServerTools (server-tools branch)", () => {
  let saved: {
    copilotToken: typeof state.copilotToken
    vsCodeVersion: typeof state.vsCodeVersion
    accountType: typeof state.accountType
    stWebSearchEnabled: typeof state.stWebSearchEnabled
    stWebSearchApiKey: typeof state.stWebSearchApiKey
    optToolCallDebug: typeof state.optToolCallDebug
    models: typeof state.models
  }
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    saved = {
      copilotToken: state.copilotToken,
      vsCodeVersion: state.vsCodeVersion,
      accountType: state.accountType,
      stWebSearchEnabled: state.stWebSearchEnabled,
      stWebSearchApiKey: state.stWebSearchApiKey,
      optToolCallDebug: state.optToolCallDebug,
      models: state.models,
    }
    state.copilotToken = "test-token"
    state.vsCodeVersion = "1.90.0"
    state.accountType = "individual"
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "tvly-test-key"
    state.optToolCallDebug = true
    state.models = {
      object: "list",
      data: [{
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        object: "model",
        version: "2025-04-14",
        vendor: "anthropic",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          tokenizer: "cl100k_base",
          object: "model_capabilities",
          type: "chat",
          supports: { tool_calls: true, parallel_tool_calls: true, dimensions: null },
          limits: { max_context_window_tokens: 200000, max_output_tokens: 8192, max_prompt_tokens: null, max_inputs: null },
        },
        policy: null,
        supported_endpoints: ["/v1/messages", "/chat/completions"],
      }],
    }
    fetchSpy = spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    state.copilotToken = saved.copilotToken
    state.vsCodeVersion = saved.vsCodeVersion
    state.accountType = saved.accountType
    state.stWebSearchEnabled = saved.stWebSearchEnabled
    state.stWebSearchApiKey = saved.stWebSearchApiKey
    state.optToolCallDebug = saved.optToolCallDebug
    state.models = saved.models
    fetchSpy.mockRestore()
  })

  function payloadWithWebSearch(stream = false): AnthropicMessagesPayload {
    return {
      model: "claude-sonnet-4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "search the docs" }],
      system: null,
      metadata: null,
      stop_sequences: null,
      stream,
      temperature: null,
      top_p: null,
      top_k: null,
      tools: [{
        name: "web_search",
        type: "web_search_20250305",
        description: "Search the web",
        input_schema: { type: "object" },
      }],
      tool_choice: null,
      thinking: null,
      service_tier: null,
    } as unknown as AnthropicMessagesPayload
  }

  function nativeAssistantResponse(text: string): AnthropicResponse {
    return {
      id: "msg_native_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        service_tier: null,
      },
    }
  }

  test("non-streaming: synthesizes response from web_search via native server-tool path", async () => {
    const searchSpy = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "ZXhhbXBsZQ==" },
      ],
      textContent: "Example body",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(nativeAssistantResponse("Synthesized native answer")), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    )

    const { handleCompletion } = await import("../../src/routes/messages/handler")
    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const res = await app.request(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadWithWebSearch(false)),
    }))

    expect(res.status).toBe(200)
    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.githubcopilot.com/v1/messages")

    searchSpy.mockRestore()
  })

  test("streaming: replays resolved server-tool response as SSE", async () => {
    const searchSpy = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "ZXhhbXBsZQ==" },
      ],
      textContent: "Example body",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(nativeAssistantResponse("Streamed reply")), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    )

    const { handleCompletion } = await import("../../src/routes/messages/handler")
    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const res = await app.request(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadWithWebSearch(true)),
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("message_start")
    expect(text).toContain("Streamed reply")

    searchSpy.mockRestore()
  })

  test("error path: surfaces upstream failure via forwardError", async () => {
    const searchSpy = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "ZXhhbXBsZQ==" },
      ],
      textContent: "Example body",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "boom", type: "api_error" } }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    )

    const { handleCompletion } = await import("../../src/routes/messages/handler")
    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const res = await app.request(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadWithWebSearch(false)),
    }))

    expect(res.status).toBeGreaterThanOrEqual(400)
    searchSpy.mockRestore()
  })

  test("effort fallback: retries server-tools native call when 400 invalid_reasoning_effort", async () => {
    const searchSpy = spyOn(tavilyModule, "searchTavily").mockResolvedValueOnce({
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "ZXhhbXBsZQ==" },
      ],
      textContent: "Example body",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        error: {
          code: "invalid_reasoning_effort",
          message: 'output_config.effort "max" is not supported by model claude-sonnet-4; supported values: [medium]',
        },
      }), { status: 400, headers: { "content-type": "application/json" } }),
    )
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(nativeAssistantResponse("After fallback")), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    )

    const { handleCompletion } = await import("../../src/routes/messages/handler")
    const app = new Hono()
    app.post("/v1/messages", handleCompletion)

    const payload = { ...payloadWithWebSearch(false), output_config: { effort: "max" } }
    const res = await app.request(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }))

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
    const secondBody = JSON.parse(secondInit.body as string)
    expect(secondBody.output_config?.effort).toBe("medium")
    searchSpy.mockRestore()
  })
})

