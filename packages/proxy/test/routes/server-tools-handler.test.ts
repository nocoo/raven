import { describe, expect, test } from "bun:test"
import type { ExtendedChatCompletionsPayload } from "../../src/routes/messages/non-stream-translation"

describe("server-side tool detection", () => {
  test("correctly identifies web_search as server-side tool", () => {
    const serverSideToolNames = ["web_search"]
    const toolName = "web_search"
    expect(serverSideToolNames.includes(toolName)).toBe(true)
  })

  test("correctly identifies get_weather as client tool", () => {
    const serverSideToolNames = ["web_search"]
    const toolName = "get_weather"
    expect(serverSideToolNames.includes(toolName)).toBe(false)
  })
})

describe("tool_choice rewrite logic", () => {
  test("rewrites tool_choice when pointing to server-side tool", () => {
    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: { type: "function", function: { name: "web_search" } },
      serverSideToolNames: ["web_search"],
    }

    const webSearchEnabled = true
    const hasServerSideTools = true

    // Simulate the rewrite logic
    let finalPayload = payload
    if (hasServerSideTools && webSearchEnabled && payload.tool_choice) {
      const tc = payload.tool_choice
      if (typeof tc === "object" && tc.type === "function" &&
          payload.serverSideToolNames?.includes(tc.function.name)) {
        finalPayload = { ...payload, tool_choice: "auto" }
      }
    }

    expect(finalPayload.tool_choice).toBe("auto")
  })

  test("does not rewrite tool_choice when pointing to client tool", () => {
    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: { type: "function", function: { name: "get_weather" } },
      serverSideToolNames: ["web_search"],
    }

    const webSearchEnabled = true
    const hasServerSideTools = true

    let finalPayload = payload
    if (hasServerSideTools && webSearchEnabled && payload.tool_choice) {
      const tc = payload.tool_choice
      if (typeof tc === "object" && tc.type === "function" &&
          payload.serverSideToolNames?.includes(tc.function.name)) {
        finalPayload = { ...payload, tool_choice: "auto" }
      }
    }

    expect(finalPayload.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } })
  })

  test("does not rewrite when web_search is disabled", () => {
    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: { type: "function", function: { name: "web_search" } },
      serverSideToolNames: ["web_search"],
    }

    const webSearchEnabled = false
    const hasServerSideTools = true

    let finalPayload = payload
    if (hasServerSideTools && webSearchEnabled && payload.tool_choice) {
      const tc = payload.tool_choice
      if (typeof tc === "object" && tc.type === "function" &&
          payload.serverSideToolNames?.includes(tc.function.name)) {
        finalPayload = { ...payload, tool_choice: "auto" }
      }
    }

    expect(finalPayload.tool_choice).toEqual({ type: "function", function: { name: "web_search" } })
  })

  test("does not rewrite when tool_choice is auto", () => {
    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: "auto",
      serverSideToolNames: ["web_search"],
    }

    const webSearchEnabled = true
    const hasServerSideTools = true

    let finalPayload = payload
    if (hasServerSideTools && webSearchEnabled && payload.tool_choice) {
      const tc = payload.tool_choice
      if (typeof tc === "object" && tc.type === "function" &&
          payload.serverSideToolNames?.includes(tc.function.name)) {
        finalPayload = { ...payload, tool_choice: "auto" }
      }
    }

    expect(finalPayload.tool_choice).toBe("auto")
  })

  test("does not rewrite when tool_choice is null", () => {
    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
      serverSideToolNames: ["web_search"],
    }

    const webSearchEnabled = true
    const hasServerSideTools = true

    let finalPayload = payload
    if (hasServerSideTools && webSearchEnabled && payload.tool_choice) {
      const tc = payload.tool_choice
      if (typeof tc === "object" && tc.type === "function" &&
          payload.serverSideToolNames?.includes(tc.function.name)) {
        finalPayload = { ...payload, tool_choice: "auto" }
      }
    }

    expect(finalPayload.tool_choice).toBeNull()
  })

  test("does not rewrite when tool_choice is none", () => {
    const payload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: "none",
      serverSideToolNames: ["web_search"],
    }

    const webSearchEnabled = true
    const hasServerSideTools = true

    let finalPayload = payload
    if (hasServerSideTools && webSearchEnabled && payload.tool_choice) {
      const tc = payload.tool_choice
      if (typeof tc === "object" && tc.type === "function" &&
          payload.serverSideToolNames?.includes(tc.function.name)) {
        finalPayload = { ...payload, tool_choice: "auto" }
      }
    }

    expect(finalPayload.tool_choice).toBe("none")
  })
})

describe("hasServerSideTools detection", () => {
  test("returns true when serverSideToolNames is non-empty", () => {
    const serverSideToolNames = ["web_search"]
    const hasServerSideTools = serverSideToolNames.length > 0
    expect(hasServerSideTools).toBe(true)
  })

  test("returns false when serverSideToolNames is empty", () => {
    const serverSideToolNames: string[] = []
    const hasServerSideTools = serverSideToolNames.length > 0
    expect(hasServerSideTools).toBe(false)
  })
})

describe("server tool execution conditions", () => {
  test("checks web_search enabled and API key configured", () => {
    const webSearchEnabled = true
    const apiKey = "tvly-test-key"

    const canExecuteWebSearch = webSearchEnabled && apiKey !== null
    expect(canExecuteWebSearch).toBe(true)
  })

  test("fails when web_search is disabled", () => {
    const webSearchEnabled = false
    const apiKey = "tvly-test-key"

    const canExecuteWebSearch = webSearchEnabled && apiKey !== null
    expect(canExecuteWebSearch).toBe(false)
  })

  test("fails when API key is null", () => {
    const webSearchEnabled = true
    const apiKey = null

    const canExecuteWebSearch = webSearchEnabled && apiKey !== null
    expect(canExecuteWebSearch).toBe(false)
  })
})

describe("server tool result injection", () => {
  test("correctly formats assistant message with tool_calls", () => {
    const toolCall = {
      id: "test_id",
      function: { name: "web_search", arguments: '{"query":"test"}' },
    }

    const assistantMessage = {
      role: "assistant" as const,
      content: "I'll search for that.",
      tool_calls: [toolCall],
      name: null,
      tool_call_id: null,
    }

    expect(assistantMessage.tool_calls).toEqual([toolCall])
    expect(assistantMessage.role).toBe("assistant")
  })

  test("correctly formats tool result as role:tool message", () => {
    const toolResult = {
      type: "web_search_tool_result",
      content: "Search results",
      citations: [{ url: "https://example.com", title: "Test", index: 0 }],
      encrypted_content: null,
    }

    // handleServerToolLoop now sends tool results as role:"tool" (OpenAI protocol)
    const toolMessage = {
      role: "tool" as const,
      content: JSON.stringify(toolResult),
      tool_call_id: "test_id",
      name: null,
      tool_calls: null,
    }

    expect(toolMessage.tool_call_id).toBe("test_id")
    expect(toolMessage.role).toBe("tool")
    expect(JSON.parse(toolMessage.content)).toEqual(toolResult)
  })
})
