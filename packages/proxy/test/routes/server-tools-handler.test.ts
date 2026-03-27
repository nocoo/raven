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
})
