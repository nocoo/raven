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
  test.each(["\n", "\r", "\r\n"])("preserves UTF-8 and event fields at every byte boundary with %j", async (newline) => {
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

  test("BUG R05: CRLF split across reads must not detach event names from data", async () => {
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

  test("single-byte chunks with empty reads preserve one UTF-8 CRLF event", async () => {
    const encoder = new TextEncoder()
    const wire = encoder.encode('event: content_block_delta\r\ndata: {"text":"你好 🐦"}\r\n\r\n')
    const chunks: Uint8Array[] = []
    for (const byte of wire) {
      chunks.push(new Uint8Array(0), new Uint8Array([byte]), new Uint8Array(0))
    }
    expect(await Array.fromAsync(events(responseFrom(chunks)))).toEqual([{
      event: "content_block_delta",
      data: '{"text":"你好 🐦"}',
      id: null, retry: null,
    }])
  })

  test("mixed LF, CRLF and a final CR at EOF keep field and data semantics", async () => {
    const encoder = new TextEncoder()
    expect(await Array.fromAsync(events(responseFrom([
      encoder.encode("data: a\n\n"),
      encoder.encode("event: ping\r\ndata: b\r\n\r\n"),
      encoder.encode("data: c\r"),
    ])))).toEqual([
      { data: "a", event: null, id: null, retry: null },
      { data: "b", event: "ping", id: null, retry: null },
      { data: "c", event: null, id: null, retry: null },
    ])
  })

  test("EOF after a final CR completes the line without an extra blank event", async () => {
    const encoder = new TextEncoder()
    expect(await Array.fromAsync(events(responseFrom([
      encoder.encode("data: tail\r"),
    ])))).toEqual([{ data: "tail", event: null, id: null, retry: null }])
  })

  test("CR then empty reads then LF is a single terminator", async () => {
    const encoder = new TextEncoder()
    expect(await Array.fromAsync(events(responseFrom([
      encoder.encode("data: x\r"),
      new Uint8Array(0),
      new Uint8Array(0),
      encoder.encode("\n\n"),
    ])))).toEqual([{ data: "x", event: null, id: null, retry: null }])
  })

  test("a long unterminated line round-trips across many chunks", async () => {
    const payload = "a".repeat(8000) + " 你好"
    const wire = new TextEncoder().encode(`data: ${payload}\n\n`)
    const chunks: Uint8Array[] = []
    for (let i = 0; i < wire.length; i += 97) chunks.push(wire.slice(i, i + 97))
    expect(await Array.fromAsync(events(responseFrom(chunks)))).toEqual([{
      data: payload, event: null, id: null, retry: null,
    }])
  })

  test("consecutive CR and mixed line endings preserve separate events at every split", async () => {
    const wire = new TextEncoder().encode("event: alpha\rdata: a\r\revent: beta\r\ndata: b\r\n\r\n")
    for (let split = 1; split < wire.length; split++) {
      expect(await Array.fromAsync(events(responseFrom([
        wire.slice(0, split), wire.slice(split),
      ]))), `byte boundary ${split}`).toEqual([
        { event: "alpha", data: "a", id: null, retry: null },
        { event: "beta", data: "b", id: null, retry: null },
      ])
    }
  })

  test("incomplete UTF-8 at EOF uses the decoder replacement character", async () => {
    expect(await Array.fromAsync(events(responseFrom([
      new TextEncoder().encode("data: "), new Uint8Array([0xe4, 0xbd]),
    ])))).toEqual([{ event: null, data: "\uFFFD", id: null, retry: null }])
  })

  test("BUG R06a: returning the SSE iterator must cancel the upstream body", async () => {
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
