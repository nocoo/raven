import { Hono } from "hono"
import { describe, expect, test, vi } from "vitest"
import type { AnthropicMessagesPayload, AnthropicResponse, AnthropicStreamEventData } from "../../src/protocols/anthropic/types"
import { consumeStreamToResponse } from "../../src/protocols/translate/consume-stream"
import { translateToAnthropic } from "../../src/protocols/translate/non-stream-translation"
import { decorate } from "../../src/strategies/support/server-tools"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { events } from "../../src/util/sse"

const payload: AnthropicMessagesPayload = {
  model: "test", max_tokens: 100, messages: [{ role: "user", content: "search something" }],
  system: null, metadata: null, stop_sequences: null, stream: false, temperature: null,
  top_p: null, top_k: null, tools: null, tool_choice: null, thinking: null, service_tier: null,
}

describe.each([false, true])("pure server-tools stream=%s", (stream) => {
  test.each([
    ["refusal", null], ["max_tokens", null], ["stop_sequence", "STOP"], ["end_turn", null],
  ] as const)("preserves native synthesis %s and stop sequence", async (reason, sequence) => {
    const synthesized: AnthropicResponse = {
      id: "native", model: "test", type: "message", role: "assistant",
      content: [{ type: "text", text: "Explanation \n" }], stop_reason: reason, stop_sequence: sequence,
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: null, service_tier: null },
    }
    await verify(synthesized, stream)
  })

  test.each(["Cannot comply.\n", "", null, undefined])("preserves reassembled translated refusal %j", async (refusal) => {
    const chunks = [
      { choices: [{ delta: { content: "Intro: " }, finish_reason: null }] },
      { choices: [{ delta: { refusal }, finish_reason: "content_filter" }] },
      { choices: [], usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38, prompt_tokens_details: { cached_tokens: 11 } } },
    ]
    const response = await consumeStreamToResponse(events(new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""))))
    const synthesized = translateToAnthropic(response, "test")
    expect(synthesized.stop_reason).toBe(refusal ? "refusal" : "end_turn")
    await verify(synthesized, stream)
  })
})

async function verify(synthesized: AnthropicResponse, stream: boolean) {
  const logs: LogEvent[] = []
  const listener = (e: LogEvent) => { if (e.type === "request_end") logs.push(e) }
  logEmitter.on("log", listener)
  try {
    const executor = vi.fn().mockResolvedValue({ content: [], textContent: "result" })
    const sendRequest = vi.fn().mockResolvedValue(synthesized)
    const app = new Hono()
    app.post("/x", (c) => decorate({
      c, requestId: "tools-refusal", startTime: performance.now(), stream, model: "test", payload,
      serverToolContext: { serverSideToolNames: ["web_search"], hasServerSideTools: true, allServerSide: true },
      sendRequest, options: { executor },
      log: { path: "/x", format: "anthropic", accountName: "test", apiKeyId: "test", sessionId: "test", clientName: "test", clientVersion: null },
    }))
    const response = await app.request("/x", { method: "POST" })
    expect(response.status).toBe(200)
    const expectedText = synthesized.content.flatMap((b) => b.type === "text" ? [b.text] : []).join("\n\n")
    if (stream) {
      const frames = (await Array.fromAsync(events(response))).map((e) => JSON.parse(e.data) as AnthropicStreamEventData)
      expect(frames.filter((e) => e.type === "message_delta")).toMatchObject([{
        delta: { stop_reason: synthesized.stop_reason, stop_sequence: synthesized.stop_sequence },
        usage: { output_tokens: 7, cache_read_input_tokens: 11 },
      }])
      expect(frames.filter((e) => e.type === "message_delta")).toHaveLength(1)
      expect(frames.filter((e) => e.type === "message_stop")).toHaveLength(1)
      expect(frames.flatMap((e) => e.type === "content_block_delta" && e.delta.type === "text_delta" ? [e.delta.text] : []).join("")).toBe(expectedText)
    } else {
      const body = await response.json() as AnthropicResponse
      expect(body).toMatchObject({ stop_reason: synthesized.stop_reason, stop_sequence: synthesized.stop_sequence, usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 11 } })
      expect(body.content.at(-1)).toEqual({ type: "text", text: expectedText })
    }
    expect(executor).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]!.data).toMatchObject({ status: "success", stopReason: synthesized.stop_reason, inputTokens: 20, outputTokens: 7 })
  } finally { logEmitter.off("log", listener) }
}
