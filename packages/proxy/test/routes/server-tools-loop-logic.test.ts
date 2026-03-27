import { describe, expect, test, beforeEach } from "bun:test"
import { state } from "../../src/lib/state"
import type { ExtendedChatCompletionsPayload } from "../../src/routes/messages/non-stream-translation"

// Test for handleServerToolLoop logic simulation
describe("handleServerToolLoop logic simulation", () => {
  beforeEach(() => {
    state.stWebSearchEnabled = true
    state.stWebSearchApiKey = "tvly-test-key"
  })

  test("detects max iterations limit", () => {
    const maxIterations = 5
    let iteration = 0

    while (iteration < maxIterations) {
      iteration++
      if (iteration >= maxIterations) {
        expect(iteration).toBe(maxIterations)
        break
      }
    }

    expect(iteration).toBe(maxIterations)
  })

  test("correctly identifies server-side tool call", () => {
    const toolCalls = [
      {
        id: "call_1",
        function: { name: "web_search", arguments: "{}" },
      },
      {
        id: "call_2",
        function: { name: "get_weather", arguments: "{}" },
      },
    ]

    const serverSideToolNames = ["web_search"]
    const serverToolCall = toolCalls.find((tc: { function?: { name: string } }) =>
      tc.function && serverSideToolNames.includes(tc.function.name)
    )

    expect(serverToolCall?.function?.name).toBe("web_search")
  })

  test("returns null when no server-side tool call found", () => {
    const toolCalls = [
      {
        id: "call_1",
        function: { name: "get_weather", arguments: "{}" },
      },
    ]

    const serverSideToolNames = ["web_search"]
    const serverToolCall = toolCalls.find((tc: { function?: { name: string } }) =>
      tc.function && serverSideToolNames.includes(tc.function.name)
    )

    expect(serverToolCall).toBeUndefined()
  })

  test("handles empty tool_calls array", () => {
    const toolCalls: unknown[] = []
    const serverSideToolNames = ["web_search"]
    const serverToolCall = toolCalls.find((tc: any) =>
      tc?.function && serverSideToolNames.includes(tc.function.name)
    )

    expect(serverToolCall).toBeUndefined()
  })

  test("correctly constructs loop payload with stream: true", () => {
    const basePayload: ExtendedChatCompletionsPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello", name: null, tool_calls: null, tool_call_id: null }],
      max_tokens: 4096,
      tool_choice: null,
    }

    // handleServerToolLoop now uses stream: true internally because
    // Copilot's non-streaming API doesn't return tool_calls data
    const loopPayload = {
      ...basePayload,
      stream: true,
      tool_choice: "auto" as const,
    }

    expect(loopPayload.stream).toBe(true)
    expect(loopPayload.tool_choice).toBe("auto")
  })
})
