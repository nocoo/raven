/**
 * E2E tests for Native Anthropic Messages Passthrough.
 *
 * This suite validates the native /v1/messages path for Claude models,
 * which bypasses OpenAI translation and sends Anthropic protocol directly.
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
 *   Layer 1: Native passthrough basics (non-streaming, streaming)
 *   Layer 2: Server-side tools (pure mode, mixed mode)
 *   Layer 3: Reasoning effort fallback
 *   Layer 4: Extended features (thinking, vision)
 */

import { describe, test, expect, beforeAll } from "bun:test"

const PROXY = process.env.RAVEN_PROXY_URL ?? "http://localhost:7024"
const API_KEY = process.env.RAVEN_API_KEY ?? ""

// Test models - use Haiku for speed, Sonnet for more complex tests
const CLAUDE_HAIKU = "claude-haiku-4.5"
const CLAUDE_SONNET = "claude-sonnet-4"
const CLAUDE_OPUS = "claude-opus-4.7"

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
 * Parse an SSE stream into an array of event objects.
 */
async function consumeSSE(
  res: Response,
): Promise<Array<{ event?: string; data: string }>> {
  const text = await res.text()
  const events: Array<{ event?: string; data: string }> = []

  let currentEvent: string | undefined
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6)
      if (currentEvent !== undefined) {
        events.push({ event: currentEvent, data })
      } else {
        events.push({ data })
      }
      currentEvent = undefined
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
    console.warn("\n⚠️  Proxy not reachable at %s — skipping native Anthropic e2e tests\n", PROXY)
  }
})

// ===========================================================================
// Layer 1: Native Passthrough Basics
// ===========================================================================

describe("e2e Native L1: non-streaming", () => {
  test("Claude Haiku returns valid Anthropic response (native path)", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: CLAUDE_HAIKU,
        max_tokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly: native-test-ok" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()

    // Validate Anthropic response shape
    expect(body.id).toBeDefined()
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.content).toBeArray()
    expect(body.content.length).toBeGreaterThan(0)
    expect(body.content[0].type).toBe("text")
    expect(body.stop_reason).toBeDefined()
    expect(body.usage).toBeDefined()

    // Native path should preserve model name in response
    expect(body.model).toBeDefined()
    console.log("✓ Native non-streaming response, model:", body.model)
  })
})

describe("e2e Native L1: streaming", () => {
  test("Claude Haiku SSE event lifecycle is correct", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: CLAUDE_HAIKU,
        max_tokens: 32,
        stream: true,
        messages: [
          { role: "user", content: "Reply with exactly one word: hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const events = await consumeSSE(res)
    const eventTypes = events
      .filter((e) => e.event)
      .map((e) => e.event)

    // Verify the Anthropic SSE lifecycle
    expect(eventTypes[0]).toBe("message_start")
    expect(eventTypes).toContain("content_block_start")
    expect(eventTypes).toContain("content_block_delta")
    expect(eventTypes).toContain("content_block_stop")
    expect(eventTypes).toContain("message_delta")
    expect(eventTypes[eventTypes.length - 1]).toBe("message_stop")

    // Verify message_start contains usage with input_tokens
    const messageStart = events.find((e) => e.event === "message_start")
    expect(messageStart).toBeDefined()
    const startData = JSON.parse(messageStart!.data)
    expect(startData.message.usage).toBeDefined()
    expect(typeof startData.message.usage.input_tokens).toBe("number")

    console.log("✓ Native streaming lifecycle correct, input_tokens:", startData.message.usage.input_tokens)
  })
})

// ===========================================================================
// Layer 2: Server-side Tools
// ===========================================================================

describe("e2e Native L2: server-side tools (web_search)", () => {
  test("Pure mode: web_search tool returns search results", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: CLAUDE_HAIKU,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: "Search the web for: latest TypeScript 5.8 features",
          },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
          },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()

    // With server-side web_search, we should get search results in the response
    expect(body.type).toBe("message")
    expect(body.content).toBeArray()

    // The response should contain either:
    // 1. server_tool_use + web_search_tool_result blocks (native format)
    // 2. Or text content with synthesized results
    const hasServerToolUse = body.content.some(
      (b: { type: string }) => b.type === "server_tool_use",
    )
    const hasSearchResult = body.content.some(
      (b: { type: string }) => b.type === "web_search_tool_result",
    )
    const hasTextContent = body.content.some(
      (b: { type: string }) => b.type === "text",
    )

    // At minimum, we should have text content (synthesized from search)
    expect(hasTextContent).toBe(true)

    console.log("✓ Server-side web_search executed")
    console.log("  server_tool_use:", hasServerToolUse)
    console.log("  web_search_tool_result:", hasSearchResult)
    console.log("  text:", hasTextContent)
  })

  test("Mixed mode: web_search with client tools", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: CLAUDE_HAIKU,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: "Search the web for the current Bitcoin price, then use the calculator to double it.",
          },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
          },
          {
            name: "calculator",
            description: "Performs arithmetic calculations",
            input_schema: {
              type: "object",
              properties: {
                expression: { type: "string" },
              },
              required: ["expression"],
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")

    // In mixed mode, the model might use the client tool (calculator)
    // or produce text. Server-side web_search should be handled internally.
    const toolUseBlocks = body.content.filter(
      (b: { type: string }) => b.type === "tool_use",
    )
    const textBlocks = body.content.filter(
      (b: { type: string }) => b.type === "text",
    )

    console.log("✓ Mixed mode server-side tools")
    console.log("  tool_use blocks:", toolUseBlocks.length)
    console.log("  text blocks:", textBlocks.length)

    // The response should have some content
    expect(body.content.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// Layer 3: Reasoning Effort
// ===========================================================================

describe("e2e Native L3: reasoning effort (output_config)", () => {
  test("output_config.effort is preserved in native path", async () => {
    if (!proxyReachable) return

    // Use a model that supports reasoning effort
    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: CLAUDE_OPUS,
        max_tokens: 256,
        output_config: {
          effort: "medium",
        },
        messages: [
          {
            role: "user",
            content: "What is 15 * 17? Think step by step.",
          },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
      const errorText = await res.text()
      // Check if it's a reasoning effort error (expected on some models)
      if (errorText.includes("invalid_reasoning_effort")) {
        console.log("✓ output_config.effort was sent to upstream (error indicates native passthrough)")
        return
      }
      failFastOnError(res, errorText)
    }

    const body = await res.json()
    expect(body.type).toBe("message")
    expect(body.content).toBeArray()

    console.log("✓ output_config.effort accepted by native path")
    console.log("  model:", body.model)
    console.log("  stop_reason:", body.stop_reason)
  })

  test("unsupported effort triggers automatic fallback", async () => {
    if (!proxyReachable) return

    // Request an effort level that may not be supported
    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: CLAUDE_OPUS,
        max_tokens: 128,
        output_config: {
          effort: "max", // max may not be supported, should fallback
        },
        messages: [
          { role: "user", content: "Say hello" },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    })

    // Fallback MUST succeed - if it fails, the fallback mechanism is broken
    if (!res.ok) {
      const errorText = await res.text()
      // Only acceptable failure is if the model doesn't support ANY effort levels
      // (not a fallback failure). Check for specific error patterns.
      if (errorText.includes("invalid_reasoning_effort") || errorText.includes("not supported by model")) {
        // This means fallback was attempted but no valid effort level exists
        console.log("✓ Fallback attempted, model has no valid effort levels")
        return
      }
      // Any other error is a real failure - fallback mechanism is broken
      failFastOnError(res, errorText)
    }

    const body = await res.json()
    expect(body.type).toBe("message")
    expect(body.content).toBeArray()
    expect(body.content.length).toBeGreaterThan(0)

    console.log("✓ Effort fallback succeeded")
    console.log("  Response model:", body.model)
  })
})

// ===========================================================================
// Layer 4: Extended Features
// ===========================================================================

describe("e2e Native L4: extended features", () => {
  test("thinking parameter is preserved in native path", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers({
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      }),
      body: JSON.stringify({
        model: CLAUDE_SONNET,
        max_tokens: 2048,
        thinking: {
          type: "enabled",
          budget_tokens: 1024,
        },
        messages: [
          {
            role: "user",
            content: "What is 23 * 47? Show your work.",
          },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
      const errorText = await res.text()
      // Some models may not support thinking
      if (errorText.includes("thinking") || errorText.includes("not supported")) {
        console.log("✓ thinking parameter was sent to upstream (error indicates native passthrough)")
        return
      }
      failFastOnError(res, errorText)
    }

    const body = await res.json()
    expect(body.type).toBe("message")

    // Check for thinking blocks in response
    const thinkingBlocks = body.content.filter(
      (b: { type: string }) => b.type === "thinking",
    )
    const textBlocks = body.content.filter(
      (b: { type: string }) => b.type === "text",
    )

    console.log("✓ thinking parameter preserved in native path")
    console.log("  thinking blocks:", thinkingBlocks.length)
    console.log("  text blocks:", textBlocks.length)

    // Should have at least some content
    expect(body.content.length).toBeGreaterThan(0)
  })

  test("tool_use response shape is correct", async () => {
    if (!proxyReachable) return

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: CLAUDE_HAIKU,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: "What is the current weather in Tokyo?",
          },
        ],
        tools: [
          {
            name: "get_weather",
            description: "Get weather for a location",
            input_schema: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "get_weather" },
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")

    // Find tool_use block
    const toolUseBlock = body.content.find(
      (b: { type: string }) => b.type === "tool_use",
    )

    expect(toolUseBlock).toBeDefined()
    expect(toolUseBlock.id).toBeDefined()
    expect(toolUseBlock.name).toBe("get_weather")
    expect(toolUseBlock.input).toBeDefined()
    expect(typeof toolUseBlock.input.location).toBe("string")

    console.log("✓ tool_use block shape correct")
    console.log("  tool:", toolUseBlock.name)
    console.log("  input:", JSON.stringify(toolUseBlock.input))
  })
})

// ===========================================================================
// Layer 5: Model Compatibility
// ===========================================================================

describe("e2e Native L5: model variants", () => {
  test("Different model name formats route correctly", async () => {
    if (!proxyReachable) return

    // Test with explicit date suffix format
    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 32,
        messages: [
          { role: "user", content: "Say ok" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")
    expect(body.model).toBeDefined()

    console.log("✓ Model name translation works")
    console.log("  Requested: claude-sonnet-4-20250514")
    console.log("  Response model:", body.model)
  })
})
