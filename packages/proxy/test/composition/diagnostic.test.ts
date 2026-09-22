import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { runUpstreamDiagnostic } from "../../src/composition/diagnostic"
import * as strategyRegistry from "../../src/composition/strategy-registry"
import { createProvider } from "../../src/db/providers"
import { forwardError } from "../../src/lib/error"
import { logEmitter } from "../../src/util/log-emitter"
import type { LogEvent } from "../../src/util/log-event"
import type { ServerSentEvent } from "../../src/util/sse"
import { NOW, providerInput, routingFixture } from "../db/routing-fixture"

let fixture: ReturnType<typeof routingFixture>
let logs: LogEvent[]
const listen = (event: LogEvent) => logs.push(event)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  logs = []
  logEmitter.on("log", listen)
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request"))
})

afterEach(() => {
  logEmitter.off("log", listen)
  fixture.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("diagnostic failure boundary", () => {
  test("closes an unexpected strategy stream and reports one failure without consuming or retrying it", async () => {
    const provider = createProvider(fixture.db, providerInput({ format: "chat_completions" }))
    let closed = false
    const iterator = {
      next: vi.fn<() => Promise<IteratorResult<ServerSentEvent>>>().mockResolvedValue({ done: false, value: { data: "unexpected", event: null, id: null, retry: null } }),
      return: vi.fn(async (): Promise<IteratorResult<ServerSentEvent>> => {
        await Promise.resolve()
        closed = true
        return { done: true, value: undefined }
      }),
    }
    const chunks: AsyncIterable<ServerSentEvent> = { [Symbol.asyncIterator]: () => iterator }
    const realBuild = strategyRegistry.buildStrategy
    const dispatch = vi.fn(async () => ({ kind: "stream" as const, chunks }))
    const build = vi.spyOn(strategyRegistry, "buildStrategy").mockImplementation((decision, deps) => ({
      ...realBuild(decision, deps), dispatch,
    }))
    const app = new Hono().post("/test", async (c) => {
      try {
        return c.json(await runUpstreamDiagnostic(c, fixture.db, provider.id, "fixture-model"))
      } catch (error) {
        return forwardError(c, error)
      }
    })

    const response = await app.request("/test", { method: "POST" })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { message: "The diagnostic returned an unexpected stream", type: "error" } })
    expect(closed).toBe(true)
    expect(iterator.return).toHaveBeenCalledTimes(1)
    expect(iterator.next).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(build.mock.calls[0]?.[1]).toMatchObject({ allowEffortRepair: false, transport: { allowReplay: false } })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    const end = logs.filter((event) => event.type === "request_end")
    expect(end).toHaveLength(1)
    expect(end[0]?.data).toMatchObject({ status: "error", diagnostic: true, error: "The diagnostic returned an unexpected stream" })
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 0 })
  })
})
