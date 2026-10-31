import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { state } from "../../src/lib/state"
import { bootstrap, refreshNow, type SentinelHandle } from "../../src/lib/token-sentinel"
import { _resetTokenSignalForTest } from "../../src/lib/token-signal"
import { createDefaultCopilotOpenAIClient } from "../../src/upstream/copilot-openai"
import { createDefaultCopilotResponsesClient } from "../../src/upstream/copilot-responses"
import { createDefaultCopilotNativeClient } from "../../src/upstream/copilot-native"
import { createDefaultCopilotEmbeddingsClient } from "../../src/upstream/copilot-embeddings"

const saved = { ...state }
let handle: SentinelHandle

beforeEach(() => {
  vi.useFakeTimers()
  _resetTokenSignalForTest()
  state.githubToken = "fixture-github-token"
  state.accountType = "individual"
  handle = bootstrap({ token: "old-token", apiBaseUrl: "https://api.githubcopilot.com", refreshInSeconds: 1500 })
  vi.setSystemTime(Date.now() + 60_000)
})

afterEach(() => {
  handle.stop()
  Object.assign(state, saved)
  vi.restoreAllMocks()
  vi.useRealTimers()
  _resetTokenSignalForTest()
})

const clients = [
  { path: "/chat/completions", send: () => createDefaultCopilotOpenAIClient().send({ model: "fixture", messages: [{ role: "user", content: "hi" }] }) },
  { path: "/responses", send: () => createDefaultCopilotResponsesClient().send({ model: "fixture", input: "hi" }) },
  { path: "/v1/messages", send: () => createDefaultCopilotNativeClient().send({ payload: {
    model: "fixture", messages: [{ role: "user", content: "hi" }], max_tokens: 1,
    system: null, metadata: null, stop_sequences: null, stream: null, temperature: null,
    top_p: null, top_k: null, tools: null, tool_choice: null, thinking: null, service_tier: null,
  }, options: { copilotModel: "fixture" } }) },
  { path: "/embeddings", send: () => createDefaultCopilotEmbeddingsClient().send({ model: "fixture", input: "hi" }) },
]

test.each(clients)("retries $path with the refreshed token's endpoint", async ({ path, send }) => {
  const calls: { url: string; authorization: string | null }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input.toString()
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Response.json({ token: "new-token", refresh_in: 1500, expires_at: 9999999999, endpoints: { api: "https://api.enterprise.githubcopilot.com" } })
    }
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    return calls.length === 1 ? new Response("token expired", { status: 401 }) : Response.json({})
  })

  await send()
  expect(calls).toEqual([
    { url: `https://api.githubcopilot.com${path}`, authorization: "Bearer old-token" },
    { url: `https://api.enterprise.githubcopilot.com${path}`, authorization: "Bearer new-token" },
  ])
})

test.each(clients)("retries $path with another request's refreshed token and endpoint", async ({ path, send }) => {
  const calls: { url: string; authorization: string | null }[] = []
  let tokenRequests = 0
  let finishFirstRequest: (response: Response) => void = () => { throw new Error("First request was not started") }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input.toString()
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      tokenRequests += 1
      return Response.json({ token: "new-token", refresh_in: 1500, expires_at: 9999999999, endpoints: { api: "https://api.enterprise.githubcopilot.com" } })
    }
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    if (calls.length === 1) return new Promise<Response>((resolve) => { finishFirstRequest = resolve })
    return Response.json({})
  })

  const pending = send()
  expect(await refreshNow("llm-401", "old-token")).toMatchObject({ ok: true, tokenWasUpdated: true })
  finishFirstRequest(new Response("token expired", { status: 401 }))
  await pending
  expect(tokenRequests).toBe(1)
  expect(calls).toEqual([
    { url: `https://api.githubcopilot.com${path}`, authorization: "Bearer old-token" },
    { url: `https://api.enterprise.githubcopilot.com${path}`, authorization: "Bearer new-token" },
  ])
})

test.each(clients)("does not retry $path when the refreshed endpoint is invalid", async ({ path, send }) => {
  const calls: { url: string; authorization: string | null }[] = []
  let tokenRequests = 0
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input.toString()
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      tokenRequests += 1
      return Response.json({ token: "new-token", refresh_in: 1500, expires_at: 9999999999, endpoints: { api: "https://invalid.example" } })
    }
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    return new Response("token expired", { status: 401 })
  })

  await expect(send()).rejects.toThrow()
  expect(tokenRequests).toBe(1)
  expect(calls).toEqual([{ url: `https://api.githubcopilot.com${path}`, authorization: "Bearer old-token" }])
  expect(state.copilotToken).toBe("old-token")
  expect(state.copilotApiBaseUrl).toBe("https://api.githubcopilot.com")
})
