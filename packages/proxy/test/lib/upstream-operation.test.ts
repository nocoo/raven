import { describe, expect, test, vi } from "vitest"
import type { UpstreamOperationDetails } from "../../src/core/routing-types"
import { captureOperationFetch, redactUpstreamText } from "../../src/lib/upstream-operation"

describe("upstream operation evidence", () => {
  test("preserves the native response while redacting credentials before bounding diagnostic evidence", async () => {
    const credential = "fixture-operation-credential"
    const original = JSON.stringify({
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", text: `${"x".repeat(8140)}${credential}${"y".repeat(300)}` }],
      api_key: credential,
    })
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(original, {
      status: 200, headers: { "content-type": "application/json", "x-request-id": "upstream-request" },
    }))
    const details: UpstreamOperationDetails = { operation: "generation_test", request_id: "proxy-request" }
    const response = await captureOperationFetch(details, [], send as typeof fetch)("https://fixture.invalid/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${credential}` }, body: "{}",
    })
    expect(await response.text()).toBe(original)
    expect(details).toMatchObject({
      operation: "generation_test", method: "POST", url: "https://fixture.invalid/v1/responses",
      upstream_status: 200, content_type: "application/json", request_id: "proxy-request",
      response_status: "incomplete", finish_reason: "max_output_tokens", response_body_truncated: true,
    })
    expect(details.response_body).toHaveLength(8192)
    expect(details.response_body).not.toContain("fixture-operation")
    expect(send).toHaveBeenCalledTimes(1)
  })

  test("scrubs echoed secret fields and credentials from raw HTML and URL metadata", async () => {
    const body = '<p>authorization: Bearer fixture-header-token; api_key="fixture-unknown-key" URL https://fixture-user:fixture-password@fixture.invalid/v1?token=fixture-query#private</p>'
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 401, headers: { "content-type": "text/html", "request-id": "upstream-id" },
    }))
    const details: UpstreamOperationDetails = { operation: "model_discovery" }
    const response = await captureOperationFetch(details, [], send as typeof fetch)(
      new URL("https://fixture-user:fixture-password@fixture.invalid/v1?token=fixture-query#private"),
      { headers: { "x-api-key": "fixture-header-token" } },
    )
    expect(await response.text()).toBe(body)
    expect(details).toMatchObject({
      method: "GET", url: "https://fixture.invalid/v1", upstream_status: 401,
      request_id: "upstream-id", content_type: "text/html", response_body_truncated: false,
    })
    for (const secret of ["fixture-user", "fixture-password", "fixture-query", "fixture-header-token", "fixture-unknown-key", "#private"]) {
      expect(JSON.stringify(details)).not.toContain(secret)
    }
    expect(details.response_body).toContain("[REDACTED]")
  })

  test("reads Request metadata and redacts nested credential fields without hiding usage token counts", async () => {
    const original = {
      choices: [{ finish_reason: "length" }],
      usage: { input_tokens: 20, output_tokens: 32 },
      debug: { authorization: "Basic fixture-basic-token", password: "fixture-password", access_token: "fixture-access-token", cookie: "fixture-cookie", nested: [{ client_secret: "fixture-client-secret" }] },
      message: "fixture-cookie",
    }
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(original))
    const details: UpstreamOperationDetails = { operation: "generation_test" }
    const request = new Request("https://fixture.invalid/chat/completions", { method: "POST", headers: { Cookie: "fixture-cookie", Authorization: "Basic fixture-basic-token" }, body: "{}" })
    const response = await captureOperationFetch(details, [], send as typeof fetch)(request)
    expect(await response.json()).toEqual(original)
    expect(details.method).toBe("POST")
    expect(details.finish_reason).toBe("length")
    expect(JSON.parse(details.response_body!)).toMatchObject({ usage: original.usage, debug: { authorization: "[REDACTED]", password: "[REDACTED]", access_token: "[REDACTED]", cookie: "[REDACTED]", nested: [{ client_secret: "[REDACTED]" }] }, message: "[REDACTED]" })
  })

  test("preserves an empty response and its HTTP status", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const details: UpstreamOperationDetails = { operation: "model_discovery" }
    const response = await captureOperationFetch(details, [], send as typeof fetch)("https://fixture.invalid/models")
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe("")
    expect(details).toEqual({ operation: "model_discovery", method: "GET", url: "https://fixture.invalid/models", upstream_status: 204, response_body: "", response_body_truncated: false })
  })

  test("retains safe request metadata when transport or body reading fails", async () => {
    const error = new Error("fixture socket closed")
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(error).mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(error) } })))
    const details: UpstreamOperationDetails = { operation: "generation_test" }
    const capture = captureOperationFetch(details, [], send as typeof fetch)
    await expect(capture("not a URL with fixture-secret")).rejects.toBe(error)
    expect(details).toEqual({ operation: "generation_test", method: "GET", url: "[invalid URL]" })
    const response = await capture("https://fixture.invalid/v1/responses")
    await expect(response.json()).rejects.toBe(error)
    expect(details.upstream_status).toBe(200)
    expect(details.response_body).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
  })

  test("sanitizes JSON scalars and Anthropic finish metadata", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(null)).mockResolvedValueOnce(Response.json({ stop_reason: "max_tokens" }))
    const details: UpstreamOperationDetails = { operation: "generation_test" }
    const capture = captureOperationFetch(details, [], send as typeof fetch)
    await (await capture("https://fixture.invalid/messages")).json()
    expect(details.response_body).toBe("null")
    await (await capture("https://fixture.invalid/messages")).json()
    expect(details.finish_reason).toBe("max_tokens")
  })

  test("redacts encoded and escaped credential echoes", () => {
    const credential = 'fixture-credential/"\\\n'
    const text = `${credential} ${encodeURIComponent(credential)} ${JSON.stringify(credential)} https://[invalid`
    const safe = redactUpstreamText(text, [credential, ""])
    expect(safe).not.toContain("fixture-credential")
    expect(safe).toContain("[invalid URL]")
  })

  test("a secret crossing the excerpt boundary never leaks a credential prefix", async () => {
    const credential = "fixture-boundary-credential"
    const body = `${"x".repeat(8188)}${credential}${"y".repeat(100)}`
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const details: UpstreamOperationDetails = { operation: "generation_test" }
    const response = await captureOperationFetch(details, [credential], send as typeof fetch)("https://fixture.invalid/responses")
    expect(await response.text()).toBe(body)
    expect(details.response_body?.slice(-4)).toBe("[RED")
    expect(details.response_body).not.toContain("fixt")
    expect(details.response_body_truncated).toBe(true)
  })

  test("returns JSON transport without consuming the body until the client reads it", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode('{"output_text":"pong"}'))
      controller.close()
    })
    const original = new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } })
    const send = vi.fn<typeof fetch>().mockResolvedValue(original)
    const details: UpstreamOperationDetails = { operation: "generation_test" }
    const response = await captureOperationFetch(details, [], send as typeof fetch)("https://fixture.invalid/responses")
    expect(response).toBe(original)
    expect(pull).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
    expect(details.response_body).toBeUndefined()
    expect(await response.json()).toEqual({ output_text: "pong" })
    expect(pull).toHaveBeenCalledTimes(1)
    expect(response.bodyUsed).toBe(true)
    expect(JSON.parse(details.response_body!)).toEqual({ output_text: "pong" })
    await expect(response.json()).rejects.toBeInstanceOf(TypeError)
  })

  test.each([200, 429])("cancels held-open SSE immediately without consuming or retrying it (HTTP %s)", async (status) => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const source = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(source, { status, headers: { "content-type": "Text/Event-Stream; charset=utf-8" } }))
    const details: UpstreamOperationDetails = { operation: "generation_test", request_id: "fixture-request" }
    await expect(captureOperationFetch(details, [], send as typeof fetch)("https://fixture.invalid/responses", { method: "POST" })).rejects.toMatchObject({
      status: status === 200 ? 502 : 429, message: "The diagnostic returned an unexpected stream", details,
    })
    expect(details).toEqual({ operation: "generation_test", request_id: "fixture-request", method: "POST", url: "https://fixture.invalid/responses", upstream_status: status, content_type: "Text/Event-Stream; charset=utf-8" })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pull).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  }, 1000)

  test("retains the unexpected-stream failure when cancellation itself fails", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("fixture already closed"))
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }))
    const details: UpstreamOperationDetails = { operation: "generation_test" }
    await expect(captureOperationFetch(details, [], send as typeof fetch)("https://fixture.invalid/responses")).rejects.toMatchObject({ status: 502, message: "The diagnostic returned an unexpected stream" })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
