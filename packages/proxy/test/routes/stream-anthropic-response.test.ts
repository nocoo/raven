import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { streamAnthropicResponse } from "../../src/routes/messages/handler"
import type { AnthropicResponse } from "../../src/protocols/anthropic/types"

/** Collect SSE events from a Hono streaming response. */
async function collectSSE(response: Response): Promise<Array<{ event: string | null; data: string }>> {
  const events: Array<{ event: string | null; data: string }> = []
  const reader = response.body?.getReader()
  if (!reader) return events

  const decoder = new TextDecoder()
  let buf = ""
  let currentEvent: string | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const parts = buf.split("\n\n")
    buf = parts.pop()!

    for (const part of parts) {
      if (!part.trim()) continue
      let data = ""
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          data = line.slice(5).trim()
        }
      }
      if (data) events.push({ event: currentEvent, data })
      currentEvent = null
    }
  }
  return events
}

function makeTestResponse(overrides?: Partial<AnthropicResponse>): AnthropicResponse {
  return {
    id: "msg_test123",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_abc123",
        name: "web_search",
        input: { query: "test query" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_abc123",
        content: [
          { type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "dGVzdA==" },
        ],
      },
      { type: "text", text: "Here is the answer." },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      service_tier: null,
      server_tool_use: { web_search_requests: 1 },
    },
    ...overrides,
  }
}

describe("streamAnthropicResponse", () => {
  const app = new Hono().get("/test", (c) =>
    streamAnthropicResponse(c, makeTestResponse()),
  )

  test("emits correct Anthropic SSE event sequence for web_search response", async () => {
    const res = await app.request("/test")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const events = await collectSSE(res)

    // message_start
    const start = events.find((e) => e.event === "message_start")
    expect(start).toBeDefined()
    const startData = JSON.parse(start!.data)
    expect(startData.type).toBe("message_start")
    expect(startData.message.id).toBe("msg_test123")
    expect(startData.message.content).toEqual([])
    expect(startData.message.stop_reason).toBeNull()

    // content_block_start for server_tool_use (index 0)
    const blockStarts = events.filter((e) => e.event === "content_block_start")
    expect(blockStarts).toHaveLength(3)

    const stuStart = JSON.parse(blockStarts[0]!.data)
    expect(stuStart.index).toBe(0)
    // server_tool_use should NOT have input in content_block_start
    expect(stuStart.content_block.type).toBe("server_tool_use")
    expect(stuStart.content_block.name).toBe("web_search")
    expect(stuStart.content_block.id).toBe("srvtoolu_abc123")
    expect("input" in stuStart.content_block).toBe(false)

    // input_json_delta for server_tool_use
    const deltas = events.filter((e) => e.event === "content_block_delta")
    const inputDelta = JSON.parse(deltas[0]!.data)
    expect(inputDelta.delta.type).toBe("input_json_delta")
    expect(JSON.parse(inputDelta.delta.partial_json)).toEqual({ query: "test query" })

    // content_block_start for web_search_tool_result (index 1)
    const wstrStart = JSON.parse(blockStarts[1]!.data)
    expect(wstrStart.index).toBe(1)
    expect(wstrStart.content_block.type).toBe("web_search_tool_result")
    expect(wstrStart.content_block.tool_use_id).toBe("srvtoolu_abc123")
    expect(wstrStart.content_block.content).toHaveLength(1)
    expect(wstrStart.content_block.content[0].url).toBe("https://example.com")

    // content_block_start for text (index 2) — empty text per Anthropic convention
    const textStart = JSON.parse(blockStarts[2]!.data)
    expect(textStart.index).toBe(2)
    expect(textStart.content_block.type).toBe("text")
    expect(textStart.content_block.text).toBe("")

    // text_delta
    const textDelta = JSON.parse(deltas[1]!.data)
    expect(textDelta.delta.type).toBe("text_delta")
    expect(textDelta.delta.text).toBe("Here is the answer.")

    // message_delta
    const msgDelta = events.find((e) => e.event === "message_delta")
    const msgDeltaData = JSON.parse(msgDelta!.data)
    expect(msgDeltaData.delta.stop_reason).toBe("end_turn")
    expect(msgDeltaData.usage.output_tokens).toBe(50)

    // message_stop
    const stop = events.find((e) => e.event === "message_stop")
    expect(stop).toBeDefined()
    expect(JSON.parse(stop!.data).type).toBe("message_stop")
  })

  test("handles text-only response (no server tools)", async () => {
    const textOnlyApp = new Hono().get("/test", (c) =>
      streamAnthropicResponse(c, makeTestResponse({
        content: [{ type: "text", text: "Simple answer." }],
        usage: {
          input_tokens: 50, output_tokens: 20,
          cache_creation_input_tokens: null, cache_read_input_tokens: null,
          service_tier: null,
        },
      })),
    )

    const res = await textOnlyApp.request("/test")
    const events = await collectSSE(res)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    expect(blockStarts).toHaveLength(1)
    const textStart = JSON.parse(blockStarts[0]!.data)
    expect(textStart.content_block.type).toBe("text")
    expect(textStart.content_block.text).toBe("")
  })

  test("handles empty text block", async () => {
    const emptyTextApp = new Hono().get("/test", (c) =>
      streamAnthropicResponse(c, makeTestResponse({
        content: [
          { type: "text", text: "" },
        ],
        usage: {
          input_tokens: 10, output_tokens: 0,
          cache_creation_input_tokens: null, cache_read_input_tokens: null,
          service_tier: null,
        },
      })),
    )

    const res = await emptyTextApp.request("/test")
    const events = await collectSSE(res)

    // Should have content_block_start + content_block_stop but no text_delta
    const deltas = events.filter((e) => e.event === "content_block_delta")
    expect(deltas).toHaveLength(0)
  })
})
