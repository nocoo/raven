import { describe, expect, test } from "vitest"
import { observeModelFetch, type AttemptUsage } from "../../src/composition/usage-observer"

function fakeFetch(callback: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(callback, { preconnect: () => undefined }) as typeof fetch
}

describe("model HTTP attempt observation", () => {
  test("retains the HTTP response and assigns each real invocation its own ordinal", async () => {
    const calls: AttemptUsage[] = []
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async (_input, init) => {
      expect(init?.method).toBe("POST")
      return new Response('{"usage":{"prompt_tokens":10,"completion_tokens":2}}', { status: 201, statusText: "Created", headers: { "x-request-id": "id" } })
    }))
    for (let i = 0; i < 2; i++) {
      const response = await observed("https://fixture.invalid", { method: "POST", body: "{}" })
      expect(response.status).toBe(201)
      expect(response.statusText).toBe("Created")
      expect(response.headers.get("x-request-id")).toBe("id")
      expect(await response.json()).toEqual({ usage: { prompt_tokens: 10, completion_tokens: 2 } })
    }
    expect(calls.map((call) => call.attempt_ordinal)).toEqual([0, 1])
    expect(calls[0]?.usage.complete).toBe(true)
    observed.preconnect("https://fixture.invalid")
  })

  test.each(["header", "request"])("observes SSE selected by %s, preserves all bytes and final usage", async (source) => {
    const calls: AttemptUsage[] = []
    const raw = 'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async () => new Response(raw, { headers: source === "header" ? { "content-type": "text/event-stream" } : {} })))
    const response = await observed("https://fixture.invalid", { body: source === "request" ? '{"stream":true}' : "invalid" })
    expect(await response.text()).toBe(raw)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage).toMatchObject({ input_tokens: 2, output_tokens: 3, complete: true })
  })

  test("records a network failure once without replacing the error", async () => {
    const failure = new Error("connection closed")
    const calls: AttemptUsage[] = []
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async () => { throw failure }))
    await expect(observed("https://fixture.invalid")).rejects.toBe(failure)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage.usage_present).toBe(false)
  })

  test.each(["application/json", "application/problem+json; charset=utf-8", "text/plain"])("observes the JSON error body of a streaming request (%s)", async (contentType) => {
    const calls: AttemptUsage[] = []
    const raw = '{"error":{"message":"rate limited"},"usage":{"prompt_tokens":20,"completion_tokens":3}}'
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async () => new Response(raw, { status: 429, headers: { "content-type": contentType } })))
    const response = await observed("https://fixture.invalid", { body: '{"stream":true}' })
    expect(response.status).toBe(429)
    expect(await response.text()).toBe(raw)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage).toMatchObject({ input_tokens: 20, output_tokens: 3, usage_present: true, complete: true })
  })

  test("respects a successful JSON response when streaming was requested", async () => {
    const calls: AttemptUsage[] = []
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async () => Response.json({ usage: { prompt_tokens: 20, completion_tokens: 3 } })))
    await (await observed("https://fixture.invalid", { body: '{"stream":true}' })).json()
    expect(calls[0]?.usage).toMatchObject({ input_tokens: 20, output_tokens: 3, complete: true })
  })

  test("a malformed request body does not prevent accounting for a valid JSON response", async () => {
    const calls: AttemptUsage[] = []
    const raw = '{"usage":{"prompt_tokens":7,"completion_tokens":2}}'
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async (_input, init) => {
      expect(init?.body).toBe('{"stream":')
      return new Response(raw, { headers: { "content-type": "text/plain" } })
    }))
    const response = await observed("https://fixture.invalid", { method: "POST", body: '{"stream":' })
    expect(await response.text()).toBe(raw)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      attempt_ordinal: 0,
      usage: { input_tokens: 7, output_tokens: 2, usage_present: true, complete: true },
    })
  })

  test("settles an empty body", async () => {
    const calls: AttemptUsage[] = []
    const original = new Response(null, { status: 204 })
    const observed = observeModelFetch("responses", (entry) => calls.push(entry), fakeFetch(async () => original))
    expect(await observed("https://fixture.invalid")).toBe(original)
    expect(calls[0]?.usage.complete).toBe(false)
  })

  test("keeps observed usage on cancelled streams and cancels the receiver", async () => {
    const calls: AttemptUsage[] = []
    let cancelled: unknown
    let sent = false
    const original = new Response(new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":20,"completion_tokens":1}}\n\n'))
        }
      },
      cancel(reason) { cancelled = reason },
    }), { headers: { "content-type": "text/event-stream" } })
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async () => original))
    const response = await observed("https://fixture.invalid")
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel("client disconnected")
    expect(cancelled).toBe("client disconnected")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage).toMatchObject({ input_tokens: 20, complete: false })
  })

  test("normal release after semantic EOF preserves complete usage even with an outstanding read", async () => {
    const calls: AttemptUsage[] = []
    const raw = 'data: {"usage":{"prompt_tokens":20,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
    let cancelled: unknown
    const original = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(raw)) },
      cancel(reason) { cancelled = reason },
    }), { headers: { "content-type": "text/event-stream" } })
    const observed = observeModelFetch("openai", (entry) => calls.push(entry), fakeFetch(async () => original))
    const reader = (await observed("https://fixture.invalid")).body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(raw)
    const pending = reader.read()
    await reader.cancel("protocol finished")
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(cancelled).toBe("protocol finished")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage).toMatchObject({ input_tokens: 20, output_tokens: 3, complete: true })
    expect(original.body!.locked).toBe(false)
  })

  test("propagates a receiver error while settling once", async () => {
    const calls: AttemptUsage[] = []
    const failure = new Error("stream interrupted")
    const original = new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }))
    const observed = observeModelFetch("responses", (entry) => calls.push(entry), fakeFetch(async () => original))
    const response = await observed("https://fixture.invalid")
    await expect(response.text()).rejects.toBe(failure)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage.complete).toBe(false)
  })
})
