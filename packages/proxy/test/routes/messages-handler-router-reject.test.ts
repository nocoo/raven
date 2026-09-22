import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import { routingHarness } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
beforeEach(() => { h = routingHarness() })
afterEach(() => { h.close(); vi.unstubAllGlobals() })

describe("Messages endpoint rejection", () => {
  test("a conversion-disabled rule returns an Anthropic error and one end event", async () => {
    h.bind(h.upstream().id, "chosen", { allow_conversion: false })
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetcher)
    const ends: LogEvent[] = []
    const listen = (event: LogEvent) => { if (event.type === "request_end") ends.push(event) }
    logEmitter.on("log", listen)
    try {
      const response = await h.request("/v1/messages", { model: "auto", max_tokens: 32, messages: [{ role: "user", content: "hi" }] })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "protocol_mismatch" } })
      expect(fetcher).not.toHaveBeenCalled()
      expect(ends).toHaveLength(1)
      expect(ends[0]!.data).toMatchObject({ path: "/v1/messages", format: "anthropic", statusCode: 400, status: "error", model: "auto" })
    } finally { logEmitter.off("log", listen) }
  })
})
