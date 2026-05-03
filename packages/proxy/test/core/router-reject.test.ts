import { describe, expect, test, beforeEach, afterEach } from "vitest"
import { Hono, type Context } from "hono"

import { respondRouterReject } from "../../src/core/router-reject"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import type { StrategyDecision } from "../../src/core/router"

const reject: Extract<StrategyDecision, { kind: "reject" }> = {
  kind: "reject",
  status: 400,
  errorType: "invalid_request_error",
  message: "nope",
}

let captured: LogEvent[]
let off: (() => void) | null = null

beforeEach(() => {
  captured = []
  const handler = (e: LogEvent) => { captured.push(e) }
  logEmitter.on("log", handler)
  off = () => logEmitter.off("log", handler)
})

afterEach(() => {
  off?.()
  off = null
})

function makeApp(handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono()
  app.post("/x", handler)
  return app
}

describe("respondRouterReject", () => {
  test("returns the reject status with envelope { error: { message, type } }", async () => {
    const app = makeApp((c) =>
      respondRouterReject(c, reject, {
        requestId: "req_1", startTime: performance.now(),
        path: "/v1/x", format: "openai", model: "m", stream: false,
        accountName: "acc", sessionId: "sess",
        clientName: null, clientVersion: null,
      }),
    )
    const res = await app.request("http://localhost/x", { method: "POST" })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { message: string; type: string } }
    expect(json.error.message).toBe("nope")
    expect(json.error.type).toBe("invalid_request_error")
  })

  test("emits one request_end log with status=error, statusCode, error message, no upstream tags by default", async () => {
    const app = makeApp((c) =>
      respondRouterReject(c, reject, {
        requestId: "req_2", startTime: performance.now(),
        path: "/v1/responses", format: "responses", model: "gpt-5.2", stream: true,
        accountName: "acc", sessionId: "sess",
        clientName: "raven-test", clientVersion: "0.0.1",
      }),
    )
    await app.request("http://localhost/x", { method: "POST" })

    const ends = captured.filter((e) => e.type === "request_end")
    expect(ends).toHaveLength(1)
    const data = ends[0]!.data as Record<string, unknown>
    expect(data.path).toBe("/v1/responses")
    expect(data.format).toBe("responses")
    expect(data.model).toBe("gpt-5.2")
    expect(data.stream).toBe(true)
    expect(data.status).toBe("error")
    expect(data.statusCode).toBe(400)
    expect(data.upstreamStatus).toBeNull()
    expect(data.error).toBe("nope")
    expect(data.accountName).toBe("acc")
    expect(data.sessionId).toBe("sess")
    expect(data.clientName).toBe("raven-test")
    expect(data.clientVersion).toBe("0.0.1")
    expect("upstream" in data).toBe(false)
    expect("upstreamFormat" in data).toBe(false)
  })

  test("includes upstream + upstreamFormat tags when provided", async () => {
    const app = makeApp((c) =>
      respondRouterReject(c, reject, {
        requestId: "req_3", startTime: performance.now(),
        path: "/v1/chat/completions", format: "openai", model: "claude-opus-4.6", stream: false,
        accountName: "acc", sessionId: "sess",
        clientName: null, clientVersion: null,
        upstream: "anthropic-up", upstreamFormat: "anthropic",
      }),
    )
    await app.request("http://localhost/x", { method: "POST" })

    const ends = captured.filter((e) => e.type === "request_end")
    const data = ends[0]!.data as Record<string, unknown>
    expect(data.upstream).toBe("anthropic-up")
    expect(data.upstreamFormat).toBe("anthropic")
  })
})
