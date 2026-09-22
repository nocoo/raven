import { describe, expect, test, vi } from "vitest"
import { events } from "../../src/util/sse"

describe("SSE cancellation", () => {
  test.each([undefined, null, false, 0, "", "stop"])("abort wakes a pending read with reason %j", async (reason) => {
    const controller = new AbortController()
    const reading = Promise.withResolvers<void>()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve() }, cancel })
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const iterator = events(new Response(body), controller.signal)
    const next = iterator.next()
    const rejected = expect(next).rejects.toMatchObject({ name: "AbortError" })
    await reading.promise
    controller.abort(reason)
    await rejected
    await iterator.return(undefined)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  test("already aborted signal cancels without yielding buffered events", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("data: ignored\n\n")) }, cancel,
    })
    await expect(events(new Response(body), AbortSignal.abort(null)).next()).rejects.toMatchObject({ name: "AbortError" })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  test("natural EOF flushes data and removes listener without cancellation", async () => {
    const cancel = vi.fn()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("data: tail")); c.close() }, cancel,
    })
    expect(await Array.fromAsync(events(new Response(body), controller.signal))).toEqual([
      { data: "tail", event: null, id: null, retry: null },
    ])
    controller.abort()
    expect(cancel).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })
})
