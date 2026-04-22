/**
 * C.0b — L1 tests for the pure parts of the §4.3 capture harness.
 *
 * waitForRequest itself hits a real WebSocket so lives in L2; the rest
 * (buildEndLog, rawEventFromLog, assembleFixture, captureOrDiffFixture)
 * is pure and injectable and must be covered at L1.
 */
import { describe, expect, test } from "bun:test"
import {
  assembleFixture,
  buildEndLog,
  captureOrDiffFixture,
  rawEventFromLog,
} from "../../test/e2e/refactor/capture"
import type { FixtureRequest } from "../../test/e2e/refactor/fixture-format"

describe("buildEndLog", () => {
  test("keeps invariant fields and drops latencies/identity", () => {
    const out = buildEndLog({
      path: "/v1/messages",
      format: "anthropic",
      model: "claude-opus-4.6",
      stream: true,
      status: "success",
      statusCode: 200,
      upstreamStatus: 200,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1234,
      ttftMs: 42,
      processingMs: 99,
      sessionId: "abc",
      clientName: "claude-code",
      clientVersion: "0.1.2",
      accountName: "default",
      resolvedModel: "claude-opus-4.6-dated",
    })
    expect(out.statusCode).toBe(200)
    expect(out.inputTokens).toBe(10)
    expect(out.outputTokens).toBe(5)
    expect(out.extras).toEqual({ resolvedModel: "claude-opus-4.6-dated" })
  })

  test("coerces missing fields to safe defaults", () => {
    const out = buildEndLog({
      path: "/v1/messages", format: "anthropic", model: "m",
      stream: false, status: "error", statusCode: 500,
    })
    expect(out.upstreamStatus).toBeNull()
    expect(out.inputTokens).toBe(0)
    expect(out.outputTokens).toBe(0)
    expect(out.status).toBe("error")
  })
})

describe("rawEventFromLog", () => {
  test("preserves event name when present", () => {
    expect(rawEventFromLog({ event: "message_start", data: "{\"x\":1}" }))
      .toEqual({ event: "message_start", data: "{\"x\":1}" })
  })
  test("drops event when empty/null", () => {
    expect(rawEventFromLog({ event: null, data: "[DONE]" }))
      .toEqual({ data: "[DONE]" })
    expect(rawEventFromLog({ data: "[DONE]" }))
      .toEqual({ data: "[DONE]" })
  })
})

describe("assembleFixture", () => {
  const request: FixtureRequest = {
    method: "POST",
    path: "/v1/messages",
    body: { model: "m", max_tokens: 1, messages: [] },
  }

  test("builds a valid fixture from correlated streams", () => {
    const fx = assembleFixture({
      request,
      upstreamRaw: [
        { ts: 1, type: "upstream_raw_sse", requestId: "r", data: { event: "message_start", data: "{\"type\":\"message_start\"}" } },
        { ts: 2, type: "upstream_raw_sse", requestId: "r", data: { event: null, data: "[DONE]" } },
      ],
      clientEvents: [
        { event: "message_start", data: "{\"type\":\"message_start\",\"id\":\"evolves\"}" },
      ],
      requestEnd: {
        ts: 3, type: "request_end", requestId: "r",
        data: {
          path: "/v1/messages", format: "anthropic", model: "m",
          stream: true, status: "success", statusCode: 200,
          upstreamStatus: 200, inputTokens: 1, outputTokens: 1,
          latencyMs: 50,
        },
      },
    })
    expect(fx.fixtureVersion).toBe(1)
    expect(fx.upstream_raw_chunks).toHaveLength(2)
    expect(fx.upstream_raw_chunks[0]?.event).toBe("message_start")
    expect(fx.expected_client_events[0]?.data).toContain("<id>") // scrubbed id
    expect(fx.expected_end_log.statusCode).toBe(200)
    expect(fx.expected_end_log.extras.latencyMs).toBeUndefined()
  })
})

describe("captureOrDiffFixture", () => {
  const request: FixtureRequest = {
    method: "POST",
    path: "/v1/messages",
    body: { model: "m", max_tokens: 1, messages: [] },
  }

  const fakeWait: typeof import("../../test/e2e/refactor/capture").waitForRequest = async () => ({
    requestId: "r",
    requestStart: { ts: 0, type: "request_start", requestId: "r", data: { path: "/v1/messages", model: "m" } },
    upstreamRaw: [
      { ts: 1, type: "upstream_raw_sse", requestId: "r", data: { event: "message_start", data: "{}" } },
    ],
    requestEnd: {
      ts: 2, type: "request_end", requestId: "r",
      data: {
        path: "/v1/messages", format: "anthropic", model: "m",
        stream: true, status: "success", statusCode: 200,
        upstreamStatus: 200, inputTokens: 0, outputTokens: 0,
      },
    },
  })

  test("capture mode writes fixture to disk", async () => {
    process.env.RAVEN_CAPTURE_GOLDENS = "1"
    const writes: Array<{ path: string; body: string }> = []
    const res = await captureOrDiffFixture(
      {
        scenario: { goldenPath: "x/y.json", model: "m" },
        request,
        fetchResponse: async () => new Response("", { status: 200 }),
        goldenRoot: "/tmp/fake",
      },
      {
        waitForRequest: fakeWait,
        write: async (p, body) => { writes.push({ path: p, body }) },
        readIfExists: async () => null,
      },
    )
    expect(res.mode).toBe("capture")
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe("/tmp/fake/x/y.json")
    expect(writes[0]?.body.endsWith("\n")).toBe(true)
    delete process.env.RAVEN_CAPTURE_GOLDENS
  })

  test("diff mode returns stored fixture when present", async () => {
    const stored = {
      fixtureVersion: 1,
      request,
      upstream_raw_chunks: [],
      expected_client_events: [],
      expected_end_log: {
        path: "/v1/messages", format: "anthropic", model: "m",
        stream: true, status: "success", statusCode: 200,
        upstreamStatus: 200, inputTokens: 0, outputTokens: 0, extras: {},
      },
    }
    const res = await captureOrDiffFixture(
      {
        scenario: { goldenPath: "x/y.json", model: "m" },
        request,
        fetchResponse: async () => new Response("", { status: 200 }),
        goldenRoot: "/tmp/fake",
      },
      {
        waitForRequest: fakeWait,
        write: async () => { throw new Error("should not write in diff mode") },
        readIfExists: async () => JSON.stringify(stored),
      },
    )
    expect(res.mode).toBe("diff")
    expect(res.stored).not.toBeNull()
    expect(res.live.fixtureVersion).toBe(1)
  })

  test("diff mode returns stored=null when fixture missing", async () => {
    const res = await captureOrDiffFixture(
      {
        scenario: { goldenPath: "x/y.json", model: "m" },
        request,
        fetchResponse: async () => new Response("", { status: 200 }),
        goldenRoot: "/tmp/fake",
      },
      {
        waitForRequest: fakeWait,
        write: async () => { throw new Error("nope") },
        readIfExists: async () => null,
      },
    )
    expect(res.mode).toBe("diff")
    expect(res.stored).toBeNull()
  })
})
