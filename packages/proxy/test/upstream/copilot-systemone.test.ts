import { afterEach, expect, test, vi } from "vitest"
import { CopilotSystemoneClient, defaultCopilotSystemoneConfig } from "../../src/upstream/copilot-systemone"
import { state } from "../../src/lib/state"
import { buildUpstreamClient } from "../../src/composition/upstream-registry"
import { parseCopilotApiBaseUrl } from "../../src/services/github/get-copilot-token"

const payload = { model: "microsoft-decision-1", state: "fixture", questions: { gate: { type: "noul" } } }
const saved = { ...state }
afterEach(() => { Object.assign(state, saved); vi.restoreAllMocks() })

function client(response: Response | Error) {
  const fetcher = vi.fn<typeof fetch>()
  if (response instanceof Error) fetcher.mockRejectedValue(response)
  else fetcher.mockResolvedValue(response)
  return { fetcher, client: buildUpstreamClient("copilot-systemone", { fetch: fetcher, copilotSystemone: {
    getBaseUrl: () => "https://copilot.invalid", getProxyUrl: () => "http://127.0.0.1:12345",
    snapshotAuth: () => ({ token: "synthetic-token", headers: { authorization: "Bearer synthetic-token" } }),
  } }) }
}

test("constructs the registered client with injected transport and abort signal", async () => {
  const { client: upstream, fetcher } = client(Response.json({ answers: {} }))
  const signal = new AbortController().signal
  expect(upstream).toBeInstanceOf(CopilotSystemoneClient)
  expect(await upstream.send(payload, signal)).toMatchObject({ status: 200, data: { answers: {} } })
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://copilot.invalid/v1/systemone", expect.objectContaining({ method: "POST", redirect: "manual", signal, proxy: "http://127.0.0.1:12345" }))
})

test("missing token or token API destination never guesses the personal-account endpoint", async () => {
  state.copilotToken = null
  const config = defaultCopilotSystemoneConfig()
  expect(() => config.snapshotAuth()).toThrow("Copilot token not found")
  state.copilotToken = "fixture-token"
  state.copilotApiBaseUrl = null
  expect(() => config.getBaseUrl()).toThrow("no API endpoint")
  state.copilotApiBaseUrl = "https://api.enterprise.githubcopilot.com"
  expect(config.getBaseUrl()).toBe(state.copilotApiBaseUrl)
  expect(config.snapshotAuth()).toMatchObject({ token: "fixture-token", headers: { Authorization: "Bearer fixture-token", "X-Initiator": "user" } })
})

test("aborted requests never reach fetch", async () => {
  const { client: upstream, fetcher } = client(Response.json({}))
  await expect(upstream.send(payload, AbortSignal.abort())).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

test.each(["text/html", "text/event-stream", null])("rejects unexpected successful content-type %s", async type => {
  const response = new Response("unexpected", { headers: type ? { "content-type": type } : {} })
  const { client: upstream } = client(response)
  await expect(upstream.send(payload)).rejects.toMatchObject({ name: "SystemoneUpstreamError" })
  expect(response.bodyUsed).toBe(true)
})

test("accepts JSON media suffixes and rejects malformed JSON without exposing its body", async () => {
  const { client: upstream } = client(new Response('{"answers":[]}', { headers: { "content-type": "application/vnd.decision+json; charset=utf-8" } }))
  expect(await upstream.send(payload)).toMatchObject({ status: 200, text: '{"answers":[]}' })
  const invalid = client(new Response("private garbage", { headers: { "content-type": "application/json" } }))
  await expect(invalid.client.send(payload)).rejects.toMatchObject({ name: "SystemoneUpstreamError", message: "Copilot systemone returned invalid JSON" })
})

test("non-JSON error text remains bounded and redacted, and SSE errors keep their status", async () => {
  const { client: upstream } = client(new Response(`synthetic-token ${"x".repeat(9000)}`, { status: 403 }))
  const result = await upstream.send(payload)
  expect(result).toMatchObject({ status: 403, contentType: "text/plain", data: null })
  expect(result.text.length).toBe(8192)
  expect(result.text).not.toContain("synthetic-token")
  const sse = client(new Response("data: error\n\n", { status: 429, headers: { "content-type": "text/event-stream" } }))
  await expect(sse.client.send(payload)).rejects.toMatchObject({ status: 429 })
})

test.each([false, true])("response read failure preserves cancellation=%s without leaking exception text", async aborted => {
  const controller = new AbortController()
  const response = Response.json({})
  vi.spyOn(response, "text").mockImplementation(async () => {
    if (aborted) controller.abort()
    throw new Error("synthetic-token")
  })
  const { client: upstream, fetcher } = client(response)
  await expect(upstream.send(payload, controller.signal)).rejects.toMatchObject(aborted
    ? { name: "AbortError" }
    : { name: "SystemoneUpstreamError", message: "Copilot systemone response read failed" })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test.each([undefined, "https://api.githubcopilot.com", "https://api.enterprise.githubcopilot.com/"])("validates token destination %s", input => {
  expect(parseCopilotApiBaseUrl(input)).toBe(input === undefined ? null : input.replace(/\/$/, ""))
})

test.each([null, 3, "bad", "http://api.githubcopilot.com", "https://api.githubcopilot.com.evil.test", "https://user:secret@api.githubcopilot.com", "https://api.githubcopilot.com:444", "https://api.githubcopilot.com/path", "https://api.githubcopilot.com?key=secret", "https://api.githubcopilot.com#secret"])("rejects unsafe token destination without echoing it: %s", input => {
  expect(() => parseCopilotApiBaseUrl(input)).toThrow("Invalid Copilot API endpoint in token response")
})
