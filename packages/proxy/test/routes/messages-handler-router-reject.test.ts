import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import { handleCompletion } from "../../src/routes/messages/handler"
import * as routerModule from "../../src/core/router"

// pickStrategy never returns reject for the anthropic protocol today,
// so the only way to exercise the defensive guard in
// handlers/messages/handler.ts is to spy on the router and force a
// reject decision. The guard exists to prevent future router rejects
// from silently falling through to the translated path.
describe("messages handler — router reject guard (defensive)", () => {
  let savedToken: string | null
  let routerSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    savedToken = state.copilotToken
    state.copilotToken = "test-token"
    routerSpy = vi.spyOn(routerModule, "pickStrategy").mockReturnValue({
      kind: "reject",
      status: 400,
      errorType: "invalid_request_error",
      message: "synthetic reject for guard test",
    })
  })

  afterEach(() => {
    routerSpy.mockRestore()
    state.copilotToken = savedToken
  })

  test("forwards reject decision through respondRouterReject (400 + log)", async () => {
    const captured: Array<{ type: string; data: unknown }> = []
    const handler = (e: { type: string; data: unknown }) => { captured.push(e) }
    logEmitter.on("log", handler)

    try {
      const app = new Hono()
      app.post("/v1/messages", handleCompletion)

      const res = await app.request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4.6", max_tokens: 1024, messages: [{ role: "user", content: "x" }] }),
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { message: string; type: string } }
      expect(json.error.message).toBe("synthetic reject for guard test")
      expect(json.error.type).toBe("invalid_request_error")

      const ends = captured.filter((e) => e.type === "request_end")
      expect(ends).toHaveLength(1)
      const data = ends[0]!.data as Record<string, unknown>
      expect(data.path).toBe("/v1/messages")
      expect(data.format).toBe("anthropic")
      expect(data.statusCode).toBe(400)
      expect(data.error).toBe("synthetic reject for guard test")
    } finally {
      logEmitter.off("log", handler)
    }
  })
})
