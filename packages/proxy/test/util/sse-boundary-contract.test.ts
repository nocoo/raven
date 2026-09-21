import { describe, expect, test, vi } from "vitest"
import { events } from "../../src/util/sse"

function responseFrom(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }))
}

describe("SSE transport contracts", () => {
  test.each(["\n", "\r"])("preserves UTF-8 and event fields at every byte boundary with %j", async (newline) => {
    const wire = new TextEncoder().encode([
      "event: content_block_delta",
      "id: evt-7",
      "retry: 1200",
      'data: {"text":"你好 🐦"}',
      "data: second line",
      "",
      "",
    ].join(newline))
    const expected = [{
      event: "content_block_delta", id: "evt-7", retry: 1200,
      data: '{"text":"你好 🐦"}\nsecond line',
    }]
    for (let split = 1; split < wire.length; split++) {
      expect(await Array.fromAsync(events(responseFrom([
        wire.slice(0, split), wire.slice(split),
      ]))), `byte boundary ${split}`).toEqual(expected)
    }
  })

  test.fails("BUG R05: CRLF split across reads must not detach event names from data", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      "event: content_block_delta\r",
      '\ndata: {"type":"content_block_delta","index":0}\r\n\r\n',
    ].map((chunk) => encoder.encode(chunk))
    expect(await Array.fromAsync(events(responseFrom(chunks)))).toEqual([{
      event: "content_block_delta",
      data: '{"type":"content_block_delta","index":0}',
      id: null, retry: null,
    }])
  })

  test.fails("BUG R06a: returning the SSE iterator must cancel the upstream body", async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"))
      },
      cancel,
    }))
    const iterator = events(response)
    await iterator.next()
    await iterator.return(undefined)
    const cancelled = cancel.mock.calls.length
    await response.body?.cancel()
    expect(cancelled).toBe(1)
  })
})
