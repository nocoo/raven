import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import {
  createResponses,
  hasVisionContent,
  hasAgentHistory,
  type ResponsesPayload,
} from "../../src/services/copilot/create-responses"
import { state } from "../../src/lib/state"
import { HTTPError } from "../../src/lib/error"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAVED_TOKEN = state.copilotToken

function makePayload(
  overrides: Partial<ResponsesPayload> = {},
): ResponsesPayload {
  return {
    model: "gpt-5-mini",
    input: "hello",
    ...overrides,
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
// Setup / teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.copilotToken = "test-jwt-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (SAVED_TOKEN !== undefined) state.copilotToken = SAVED_TOKEN
  else state.copilotToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// createResponses
// ===========================================================================

describe("createResponses", () => {
  test("throws when copilotToken is missing", async () => {
    state.copilotToken = null
    try {
      await createResponses(makePayload())
      expect(true).toBe(false) // should not reach
    } catch (err) {
      expect((err as Error).message).toBe("Copilot token not found")
    }
  })

  test("non-streaming request returns JSON", async () => {
    const responseBody = {
      id: "resp_123",
      object: "response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    }
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(responseBody))

    const result = await createResponses(makePayload({ stream: false }))

    expect(result).toEqual(responseBody)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.githubcopilot.com/responses")
  })

  test("streaming request returns SSE async iterable", async () => {
    const sseChunks = [
      'event: response.created\ndata: {"id":"resp_1"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
      'event: response.completed\ndata: {"id":"resp_1"}\n\n',
    ]
    fetchSpy.mockResolvedValueOnce(mockFetchStream(sseChunks))

    const result = await createResponses(makePayload({ stream: true }))

    // Should be async iterable
    expect(typeof result[Symbol.asyncIterator]).toBe("function")

    const events: unknown[] = []
    for await (const event of result as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events.length).toBe(3)
    expect((events[0] as { event: string }).event).toBe("response.created")
    expect((events[1] as { event: string }).event).toBe("response.output_text.delta")
    expect((events[2] as { event: string }).event).toBe("response.completed")
  })

  test("throws HTTPError on upstream failure", async () => {
    const errorBody = JSON.stringify({ error: { message: "model not found" } })
    fetchSpy.mockResolvedValueOnce(
      new Response(errorBody, { status: 404, headers: { "content-type": "application/json" } }),
    )

    try {
      await createResponses(makePayload())
      expect(true).toBe(false)
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).status).toBe(404)
      expect((err as HTTPError).responseBody).toContain("model not found")
    }
  })
})

// ===========================================================================
// hasVisionContent
// ===========================================================================

describe("hasVisionContent", () => {
  test("returns false for string input", () => {
    expect(hasVisionContent({ model: "gpt-5", input: "hello" })).toBe(false)
  })

  test("returns false for text-only messages", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    }
    expect(hasVisionContent(payload)).toBe(false)
  })

  test("returns true for input_image content", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,..." },
          ],
        },
      ],
    }
    expect(hasVisionContent(payload)).toBe(true)
  })
})

// ===========================================================================
// hasAgentHistory
// ===========================================================================

describe("hasAgentHistory", () => {
  test("returns false for string input", () => {
    expect(hasAgentHistory({ model: "gpt-5", input: "hello" })).toBe(false)
  })

  test("returns false for user-only messages", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5",
      input: [{ role: "user", content: "hello" }],
    }
    expect(hasAgentHistory(payload)).toBe(false)
  })

  test("returns true for assistant message", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5",
      input: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    }
    expect(hasAgentHistory(payload)).toBe(true)
  })

  test("returns true for function_call item", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5",
      input: [
        { role: "user", content: "run ls" },
        { type: "function_call", call_id: "fc_1", name: "shell", arguments: '{"cmd":"ls"}' },
      ],
    }
    expect(hasAgentHistory(payload)).toBe(true)
  })

  test("returns true for function_call_output item", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5",
      input: [
        { type: "function_call_output", call_id: "fc_1", output: "file1.txt\nfile2.txt" },
      ],
    }
    expect(hasAgentHistory(payload)).toBe(true)
  })
})
