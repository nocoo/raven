import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"

import { execute } from "../../src/core/runner"
import type { RequestContext } from "../../src/core/context"
import { makeCopilotResponses } from "../../src/strategies/copilot-responses"
import type { CopilotResponsesClient, ResponsesPayload } from "../../src/upstream/copilot-responses"
import { events, type ServerSentEvent } from "../../src/util/sse"

const ctx: RequestContext = {
  requestId: "fixture-item-ids", startTime: 0, format: "responses", path: "/v1/responses",
  stream: true, accountName: "fixture", keyId: "fixture", userAgent: null,
  anthropicBeta: null, sessionId: "fixture", clientName: "Unknown", clientVersion: null,
}

function frame(value: Record<string, unknown>): ServerSentEvent {
  return { event: String(value.type), data: JSON.stringify(value), id: "sse-id", retry: 1500 }
}

function fakeClient(send: CopilotResponsesClient["send"]): CopilotResponsesClient {
  return { send } as CopilotResponsesClient
}

describe("Copilot Responses stream identity through Runner", () => {
  test.each(["commentary", "final_answer"])("reconciles %s text as one message", async (phase) => {
    // Synthetic version of the captured Copilot failure: every event has a new
    // item ID, but streamed text and the completed message are identical.
    const message = { type: "message", role: "assistant", phase, content: [{ type: "output_text", text: "Hello world" }] }
    const input = [
      frame({ type: "response.output_item.added", output_index: 0, item: { ...message, id: "added", content: [] } }),
      frame({ type: "response.output_text.delta", output_index: 0, item_id: "delta-1", delta: "Hello " }),
      frame({ type: "response.output_text.delta", output_index: 0, item_id: "delta-2", delta: "world" }),
      frame({ type: "response.output_item.done", output_index: 0, item: { ...message, id: "done" } }),
      frame({ type: "response.completed", response: { id: "response-1", output: [{ ...message, id: "completed" }], usage: { input_tokens: 3, output_tokens: 2 } } }),
    ]
    const send = vi.fn(async () => (async function* () { yield* input })())
    const strategy = makeCopilotResponses({ client: fakeClient(send) })
    const app = new Hono()
    app.post("/v1/responses", (c) => execute(c, { ...ctx, startTime: performance.now() }, strategy, {
      model: "fixture", input: [], stream: true,
    }))
    const response = await app.request("http://fixture.invalid/v1/responses", { method: "POST" })
    const output = []
    for await (const event of events(response)) output.push(event)
    expect(send).toHaveBeenCalledTimes(1)
    expect(output).toHaveLength(input.length)

    // ID-keyed consumers must update the message they already streamed, rather
    // than insert the same text again when output_item.done arrives.
    const messages = new Map<string, string>()
    for (const [index, event] of output.entries()) {
      expect(event).toMatchObject({ event: input[index]!.event, id: "sse-id", retry: 1500 })
      const value = JSON.parse(event.data)
      if (value.type === "response.output_item.added") messages.set(value.item.id, "")
      if (value.type === "response.output_text.delta") {
        expect(messages.has(value.item_id)).toBe(true)
        messages.set(value.item_id, messages.get(value.item_id)! + value.delta)
      }
      if (value.type === "response.output_item.done") {
        messages.set(value.item.id, value.item.content[0].text)
        expect(value.item.phase).toBe(phase)
      }
      if (value.type === "response.completed") {
        expect(value.response.output[0]).toEqual({ ...message, id: "added" })
        expect(value.response.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
      }
    }
    expect([...messages.entries()]).toEqual([["added", "Hello world"]])
    expect(JSON.parse(input[3]!.data).item.id).toBe("done")
  })

  test("isolates simultaneous streams and composes with namespace restoration", () => {
    const s = makeCopilotResponses({ client: fakeClient(async () => ({})) })
    const req = s.prepare({ model: "fixture", input: [], tools: [
      { type: "namespace", name: "mcp__", tools: [{ type: "function", name: "read" }] },
    ] } as unknown as ResponsesPayload, ctx)
    const a = s.initStreamState(req, ctx)
    const b = s.initStreamState(req, ctx)
    const adapt = (value: Record<string, unknown>, state = a, header = true) => {
      const event = frame(value)
      if (!header) event.event = null
      return JSON.parse(String(s.adaptChunk(event, state, ctx)[0]!.data))
    }
    const item = { type: "function_call", name: "mcp__read", call_id: "call-1", arguments: "{}" }
    adapt({ type: "response.output_item.added", output_index: 0, item: { ...item, id: "a" } }, a, false)
    adapt({ type: "response.output_item.added", output_index: 0, item: { ...item, id: "b" } }, b)
    for (const [state, id] of [[a, "a"], [b, "b"]] as const) {
      const done = adapt({ type: "response.output_item.done", output_index: 0, item: { ...item, id: "changing" } }, state)
      expect(done.item).toEqual({ ...item, id, name: "read", namespace: "mcp__" })
    }
    const sparse = s.initStreamState(req, ctx)
    expect(adapt({ type: "response.output_text.delta", output_index: 0, item_id: "unregistered", delta: "x" }, sparse).item_id)
      .toBe("unregistered")
  })
})
