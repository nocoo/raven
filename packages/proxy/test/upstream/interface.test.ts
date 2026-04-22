import { describe, expect, test } from "bun:test"
import type { UpstreamClient, UpstreamResult } from "../../src/upstream/interface"
import type { ServerSentEvent } from "../../src/util/sse"

/**
 * Contract tests for the UpstreamClient interface (E.1).
 *
 * The interface is a structural contract — no runtime to test directly.
 * These tests pin the shape with concrete fake implementations so future
 * accidental signature drift breaks compilation (the test file fails to
 * type-check, surfacing the regression at the gate).
 */

interface FakeReq {
  prompt: string
  stream?: boolean
}

interface FakeResp {
  output: string
}

class JsonClient implements UpstreamClient<FakeReq, FakeResp> {
  async send(payload: FakeReq): Promise<UpstreamResult<FakeResp>> {
    return { output: payload.prompt }
  }
}

async function* singleEvent(value: string): AsyncGenerator<ServerSentEvent> {
  yield { data: value, event: null, id: null, retry: null }
}

class StreamClient implements UpstreamClient<FakeReq, FakeResp> {
  async send(payload: FakeReq): Promise<UpstreamResult<FakeResp>> {
    if (payload.stream) return singleEvent(payload.prompt)
    return { output: payload.prompt }
  }
}

describe("UpstreamClient contract", () => {
  test("non-stream client returns parsed Resp", async () => {
    const client = new JsonClient()
    const result = await client.send({ prompt: "hello" })
    expect(result).toEqual({ output: "hello" })
  })

  test("stream client returns AsyncGenerator when payload.stream is true", async () => {
    const client = new StreamClient()
    const result = await client.send({ prompt: "world", stream: true })
    expect(typeof (result as AsyncGenerator<ServerSentEvent>)[Symbol.asyncIterator]).toBe(
      "function",
    )
    const events: Array<ServerSentEvent> = []
    for await (const ev of result as AsyncGenerator<ServerSentEvent>) {
      events.push(ev)
    }
    expect(events).toEqual([{ data: "world", event: null, id: null, retry: null }])
  })

  test("stream client returns Resp when payload.stream is falsy", async () => {
    const client = new StreamClient()
    const result = await client.send({ prompt: "again" })
    expect(result).toEqual({ output: "again" })
  })
})
