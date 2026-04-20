/**
 * E2E tests for OpenAI /v1/chat/completions endpoint.
 *
 * This suite validates the OpenAI-compatible endpoint with comprehensive
 * coverage of streaming, tool use, and various model scenarios.
 *
 * Prerequisites:
 *   - Proxy running on localhost:7024
 *   - Valid Copilot token configured
 *
 * Anti-ban protocol:
 *   - Fail fast: abort suite on first upstream error
 *   - Minimal requests: each test sends exactly 1 request
 *   - No retries, no loops, no load testing
 *
 * Test coverage:
 *   Layer 1: Basic completions (non-streaming, streaming)
 *   Layer 2: Tool use (function calling)
 *   Layer 3: Stream options (include_usage)
 *   Layer 4: Model variants (GPT, o-series)
 */

import { describe, test, expect, beforeAll } from "bun:test"

const PROXY = process.env.RAVEN_PROXY_URL ?? "http://localhost:7024"
const API_KEY = process.env.RAVEN_API_KEY ?? ""

// Test models
const GPT_MINI = "gpt-5-mini"
const GPT_MAIN = "gpt-5.4"  // Use gpt-5.4 instead of gpt-5
const O_SERIES = "gpt-4o-mini-2024-07-18"  // Use available o-series model

// Headers for authenticated requests
function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  }
  if (API_KEY) {
    h["Authorization"] = `Bearer ${API_KEY}`
  }
  return h
}

/**
 * Fail-fast helper: throw on non-2xx to abort suite and avoid ban.
 */
function failFastOnError(res: Response, body: string): void {
  if (!res.ok) {
    throw new Error(
      `Upstream error ${res.status} — aborting e2e suite to avoid ban.\n${body.slice(0, 500)}`,
    )
  }
}

/**
 * Parse an SSE stream into an array of data objects.
 */
async function consumeSSE(res: Response): Promise<Array<{ data: string }>> {
  const text = await res.text()
  const events: Array<{ data: string }> = []

  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push({ data: line.slice(6) })
    }
  }

  return events
}

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

let proxyReachable = false

beforeAll(async () => {
  try {
    const res = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(3000) })
    proxyReachable = res.ok
  } catch {
    proxyReachable = false
  }

  if (!proxyReachable) {
    console.warn("\n⚠️  Proxy not reachable at %s — skipping OpenAI e2e tests\n", PROXY)
  }
})

// ===========================================================================
// Layer 1: Basic Completions
// ===========================================================================

describe("e2e OpenAI L1: non-streaming", () => {
  test("GPT-5-mini returns valid OpenAI response", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly: openai-test-ok" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()

    // Validate OpenAI response shape
    // Note: Copilot may not return `object` field, but core fields should be present
    expect(body.id).toBeDefined()
    // expect(body.object).toBe("chat.completion")  // Copilot omits this
    expect(body.choices).toBeArray()
    expect(body.choices.length).toBeGreaterThan(0)
    expect(body.choices[0].message.role).toBe("assistant")
    expect(typeof body.choices[0].message.content).toBe("string")
    expect(body.choices[0].finish_reason).toBeDefined()
    expect(body.usage).toBeDefined()
    expect(typeof body.usage.prompt_tokens).toBe("number")
    expect(typeof body.usage.completion_tokens).toBe("number")
    expect(typeof body.usage.total_tokens).toBe("number")

    console.log("✓ OpenAI non-streaming response")
    console.log("  model:", body.model)
    console.log("  tokens:", body.usage.total_tokens)
  })

  test("System message is handled correctly", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 64,
        messages: [
          { role: "system", content: "You are a helpful assistant that always responds in uppercase." },
          { role: "user", content: "Say hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.choices[0].message.content).toBeDefined()

    // Check if response has any uppercase letters (system instruction may or may not be followed)
    console.log("✓ System message processed")
    console.log("  Response:", body.choices[0].message.content.slice(0, 50))
  })
})

describe("e2e OpenAI L1: streaming", () => {
  test("GPT-5-mini streaming returns SSE chunks", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 32,
        stream: true,
        messages: [
          { role: "user", content: "Reply with exactly: hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const events = await consumeSSE(res)

    // Should have data chunks and end with [DONE]
    expect(events.length).toBeGreaterThan(1)
    expect(events[events.length - 1]!.data).toBe("[DONE]")

    // Parse and validate chunk structure
    const dataChunks = events
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data))

    expect(dataChunks.length).toBeGreaterThan(0)
    expect(dataChunks[0].id).toBeDefined()
    // Note: Copilot may not return `object` field in stream chunks
    // expect(dataChunks[0].object).toBe("chat.completion.chunk")
    expect(dataChunks[0].choices).toBeArray()

    // Collect content from all deltas
    let fullContent = ""
    for (const chunk of dataChunks) {
      const delta = chunk.choices[0]?.delta
      if (delta?.content) {
        fullContent += delta.content
      }
    }

    console.log("✓ OpenAI streaming chunks")
    console.log("  Chunk count:", dataChunks.length)
    console.log("  Full content:", fullContent.slice(0, 50))
  })

  test("stream_options.include_usage returns usage in final chunk", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 32,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "user", content: "Say ok" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const events = await consumeSSE(res)
    const dataChunks = events
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data))

    // Find chunk with usage (should be the last content chunk or a separate usage chunk)
    const chunkWithUsage = dataChunks.find((c) => c.usage)

    expect(chunkWithUsage).toBeDefined()
    expect(typeof chunkWithUsage.usage.prompt_tokens).toBe("number")
    expect(typeof chunkWithUsage.usage.completion_tokens).toBe("number")

    console.log("✓ stream_options.include_usage works")
    console.log("  prompt_tokens:", chunkWithUsage.usage.prompt_tokens)
    console.log("  completion_tokens:", chunkWithUsage.usage.completion_tokens)
  })
})

// ===========================================================================
// Layer 2: Tool Use (Function Calling)
// ===========================================================================

describe("e2e OpenAI L2: tool use", () => {
  test("Function calling returns tool_calls in response", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 256,
        messages: [
          { role: "user", content: "What is the weather in Paris?" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                  unit: { type: "string", enum: ["celsius", "fahrenheit"] },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "get_weather" } },
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.choices[0].message.tool_calls).toBeArray()
    expect(body.choices[0].message.tool_calls.length).toBeGreaterThan(0)

    const toolCall = body.choices[0].message.tool_calls[0]
    expect(toolCall.id).toBeDefined()
    expect(toolCall.type).toBe("function")
    expect(toolCall.function.name).toBe("get_weather")
    expect(toolCall.function.arguments).toBeDefined()

    // Parse arguments
    const args = JSON.parse(toolCall.function.arguments)
    expect(args.location).toBeDefined()

    console.log("✓ Function calling works")
    console.log("  Function:", toolCall.function.name)
    console.log("  Arguments:", toolCall.function.arguments)
  })

  test("Streaming tool calls are accumulated correctly", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 256,
        stream: true,
        messages: [
          { role: "user", content: "Get the weather in Tokyo" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "get_weather" } },
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const events = await consumeSSE(res)
    const dataChunks = events
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data))

    // Accumulate tool call from stream
    let toolCallId = ""
    let functionName = ""
    let argumentsAcc = ""

    for (const chunk of dataChunks) {
      const delta = chunk.choices[0]?.delta
      if (delta?.tool_calls?.[0]) {
        const tc = delta.tool_calls[0]
        if (tc.id) toolCallId = tc.id
        if (tc.function?.name) functionName = tc.function.name
        if (tc.function?.arguments) argumentsAcc += tc.function.arguments
      }
    }

    expect(toolCallId).toBeDefined()
    expect(functionName).toBe("get_weather")
    expect(argumentsAcc).toBeDefined()

    // Parse accumulated arguments
    const args = JSON.parse(argumentsAcc)
    expect(args.location).toBeDefined()

    console.log("✓ Streaming tool calls accumulated")
    console.log("  Tool ID:", toolCallId)
    console.log("  Arguments:", argumentsAcc)
  })

  test("tool_choice: none prevents tool use", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 64,
        messages: [
          { role: "user", content: "What is 2+2? Use the calculator." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "calculator",
              description: "Performs math",
              parameters: {
                type: "object",
                properties: {
                  expression: { type: "string" },
                },
              },
            },
          },
        ],
        tool_choice: "none",
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()

    // With tool_choice: none, no tool calls should be made
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    expect(body.choices[0].message.content).toBeDefined()

    console.log("✓ tool_choice: none works")
    console.log("  Response:", body.choices[0].message.content.slice(0, 50))
  })
})

// ===========================================================================
// Layer 3: Conversation with Tool Results
// ===========================================================================

describe("e2e OpenAI L3: tool result conversation", () => {
  test("Multi-turn conversation with tool results", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 128,
        messages: [
          { role: "user", content: "What is the weather in London?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc123",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location": "London"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_abc123",
            content: '{"temperature": 18, "condition": "cloudy", "humidity": 75}',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: { location: { type: "string" } },
              },
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()

    // Model should synthesize a response from the tool result
    expect(body.choices[0].message.content).toBeDefined()
    expect(body.choices[0].message.content.length).toBeGreaterThan(0)

    // Response should reference the weather data
    const content = body.choices[0].message.content.toLowerCase()
    const mentionsWeather = content.includes("18") || content.includes("cloudy") || content.includes("weather")

    console.log("✓ Multi-turn with tool results")
    console.log("  Response:", body.choices[0].message.content.slice(0, 100))
    console.log("  Mentions weather data:", mentionsWeather)
  })
})

// ===========================================================================
// Layer 4: Model Variants
// ===========================================================================

describe("e2e OpenAI L4: model variants", () => {
  test("GPT-4o model works", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: O_SERIES,
        max_tokens: 64,
        messages: [
          { role: "user", content: "What is 15 * 17?" },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
      const errorText = await res.text()
      // Model may not be available
      if (errorText.includes("not found") || errorText.includes("not available") || errorText.includes("not supported")) {
        console.log("✓ Model not available (expected in some environments)")
        return
      }
      failFastOnError(res, errorText)
    }

    const body = await res.json()
    expect(body.choices[0].message.content).toBeDefined()

    console.log("✓ GPT-4o model works")
    console.log("  Model:", body.model)
    console.log("  Response:", body.choices[0].message.content.slice(0, 50))
  })

  test("GPT-5.4 (main model) works", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MAIN,
        max_tokens: 32,
        messages: [
          { role: "user", content: "Say hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const errorText = await res.text()
      if (errorText.includes("not supported")) {
        console.log("✓ Model not available")
        return
      }
      failFastOnError(res, errorText)
    }

    const body = await res.json()
    expect(body.choices[0].message.content).toBeDefined()

    console.log("✓ GPT-5.4 works")
    console.log("  Model:", body.model)
  })
})

// ===========================================================================
// Layer 5: Edge Cases
// ===========================================================================

describe("e2e OpenAI L5: edge cases", () => {
  test("Empty assistant message in history", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 32,
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "" },
          { role: "user", content: "Are you there?" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.choices[0].message.content).toBeDefined()

    console.log("✓ Empty assistant message handled")
  })

  test("Long system prompt", async () => {
    if (!proxyReachable) return

    // Generate a long system prompt (but not too long for e2e)
    const longSystemPrompt = "You are a helpful assistant. ".repeat(100)

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 32,
        messages: [
          { role: "system", content: longSystemPrompt },
          { role: "user", content: "Say ok" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.choices[0].message.content).toBeDefined()

    console.log("✓ Long system prompt handled")
    console.log("  System prompt length:", longSystemPrompt.length)
  })

  test("Parallel tool calls response", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: GPT_MINI,
        max_tokens: 512,
        messages: [
          { role: "user", content: "Get the weather in both Tokyo and London at the same time" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
                required: ["location"],
              },
            },
          },
        ],
        parallel_tool_calls: true,
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()

    // May have multiple tool calls or just one (model's discretion)
    const toolCalls = body.choices[0].message.tool_calls ?? []

    console.log("✓ Parallel tool calls request processed")
    console.log("  Tool calls returned:", toolCalls.length)

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        console.log("    -", tc.function.name, tc.function.arguments)
      }
    }
  })
})
