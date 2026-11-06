import { afterEach, expect, test, vi } from "vitest"
import {
  CopilotNativeJsonClient,
  defaultCopilotNativeJsonConfig,
} from "../../src/upstream/copilot-native-json"
import { buildUpstreamClient } from "../../src/composition/upstream-registry"
import { state } from "../../src/lib/state"
import { decisionsFailed, nativeJsonError, type ImageEndpoint } from "../../src/protocols/native-json"
import { buildStrategy } from "../../src/composition/strategy-registry"
import { upstreamRecord } from "../helpers/routing"

const decisions = { model: "gpt-6-luna-decisions", input: "fixture", questions: [{ name: "gate", type: "noul" }] }
const images = { model: "gpt-image-2.5-flare", prompt: "fixture" }
const saved = { ...state }

afterEach(() => { Object.assign(state, saved); vi.restoreAllMocks() })

function client(kind: "copilot-decisions" | "copilot-images", response: Response | Error, copilotImagesEndpoint?: ImageEndpoint) {
  const fetcher = vi.fn<typeof fetch>()
  if (response instanceof Error) fetcher.mockRejectedValue(response)
  else fetcher.mockResolvedValue(response)
  const config = {
    getBaseUrl: () => "https://copilot.invalid",
    getProxyUrl: () => "http://127.0.0.1:12345",
    snapshotAuth: () => ({ token: "synthetic-token", headers: { authorization: "Bearer synthetic-token" } }),
  }
  return {
    fetcher,
    client: buildUpstreamClient(kind, { fetch: fetcher, copilotDecisions: config, copilotImages: config, ...(copilotImagesEndpoint ? { copilotImagesEndpoint } : {}) }),
  }
}

for (const entry of [
  { kind: "copilot-decisions" as const, payload: decisions, path: "/v1/decisions" },
  { kind: "copilot-images" as const, payload: images, path: "/v1/images/generations" },
]) {
  test(`${entry.kind}: constructs and sends exactly one manual-redirect native request`, async () => {
    const { client: upstream, fetcher } = client(entry.kind, new Response('{"ok":true}', { headers: { "content-type": "application/json" } }))
    const signal = new AbortController().signal
    expect(upstream).toBeInstanceOf(CopilotNativeJsonClient)
    expect(await upstream.send(entry.payload, signal)).toMatchObject({ status: 200, data: { ok: true } })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://copilot.invalid${entry.path}`, expect.objectContaining({ method: "POST", redirect: "manual", signal, proxy: "http://127.0.0.1:12345" }))
  })

  test(`${entry.kind}: aborted requests never reach fetch`, async () => {
    const { client: upstream, fetcher } = client(entry.kind, Response.json({ ok: true }))
    await expect(upstream.send(entry.payload, AbortSignal.abort())).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test(`${entry.kind}: transport and malformed successful JSON are bounded protocol failures`, async () => {
    const transport = client(entry.kind, new Error("fixture-copilot-token"))
    await expect(transport.client.send(entry.payload)).rejects.toMatchObject({ name: "CopilotNativeJsonUpstreamError" })
    const malformed = client(entry.kind, new Response("private garbage", { headers: { "content-type": "application/json" } }))
    await expect(malformed.client.send(entry.payload)).rejects.toMatchObject({ name: "CopilotNativeJsonUpstreamError" })
  })

  test(`${entry.kind}: unexpected success content type and SSE are rejected`, async () => {
    for (const response of [
      new Response("unexpected", { headers: { "content-type": "text/html" } }),
      new Response("unexpected", { headers: { "content-type": "text/event-stream" } }),
      new Response("unexpected", { headers: { "content-type": "text/plain" } }),
    ]) {
      const { client: upstream } = client(entry.kind, response)
      await expect(upstream.send(entry.payload)).rejects.toMatchObject({ name: "CopilotNativeJsonUpstreamError" })
    }
  })

  test(`${entry.kind}: non-JSON upstream errors preserve status and bound credentials`, async () => {
    const { client: upstream } = client(entry.kind, new Response(`synthetic-token ${"x".repeat(9000)}`, { status: 403, headers: { "content-type": "text/plain" } }))
    const result = await upstream.send(entry.payload)
    expect(result).toMatchObject({ status: 403, contentType: "text/plain", data: null })
    expect(result.text.length).toBe(8192)
    expect(result.text).not.toContain("synthetic-token")
  })
}

test("missing token or token API destination never guesses an account endpoint", () => {
  state.copilotToken = null
  const config = defaultCopilotNativeJsonConfig()
  expect(() => config.snapshotAuth()).toThrow("Copilot token not found")
  state.copilotToken = "fixture-token"
  state.copilotApiBaseUrl = null
  expect(() => config.getBaseUrl()).toThrow("no API endpoint")
  state.copilotApiBaseUrl = "https://api.enterprise.githubcopilot.com"
  expect(config.getBaseUrl()).toBe("https://api.enterprise.githubcopilot.com")
  expect(config.snapshotAuth()).toMatchObject({ token: "fixture-token", headers: { Authorization: "Bearer fixture-token", "X-Initiator": "user" } })
})

for (const entry of [
  { protocol: "decisions" as const, name: "gpt-6-luna-decisions" },
  { protocol: "images" as const, name: "gpt-image-2.5-flare" },
]) {
  test(`${entry.protocol}: composition rejects forged protocol conversion`, () => {
    expect(() => buildStrategy({
      kind: "ok", name: "protocol-converted", clientProtocol: entry.protocol,
      upstreamProtocol: entry.protocol, providerId: "fixture", model: entry.name,
    }, { toolCallDebug: false, provider: upstreamRecord({ kind: "copilot" }) })).toThrow("Native Copilot JSON cannot be converted")
  })

  test(`${entry.protocol}: response read failures stay protocol-bounded`, async () => {
    const response = Response.json({ ok: true })
    vi.spyOn(response, "text").mockRejectedValue(new Error("synthetic-token"))
    const { client: upstream } = client(entry.protocol === "decisions" ? "copilot-decisions" : "copilot-images", response)
    await expect(upstream.send(entry.protocol === "decisions" ? decisions : images)).rejects.toMatchObject({ name: "CopilotNativeJsonUpstreamError", message: expect.stringContaining(entry.protocol) })
  })
}

test("recognized native semantic failures include decisions refusals and image errors", () => {
  expect(decisionsFailed({ error: { message: "refused" } })).toBe(true)
  expect(decisionsFailed({ answers: [{ type: "refusal" }] })).toBe(true)
  expect(decisionsFailed({ answers: [{ choice: "test" }] })).toBe(false)
  expect(nativeJsonError({ error: { message: "bad" } })).toBe(true)
  expect(nativeJsonError({ data: [{ b64_json: "AA==" }] })).toBe(false)
})

test("image edits rejects a missing multipart payload without sending", async () => {
  const { client: upstream, fetcher } = client("copilot-images", Response.json({}), "/v1/images/edits")
  await expect(upstream.send(images)).rejects.toThrow("multipart payload")
  expect(fetcher).not.toHaveBeenCalled()
})
