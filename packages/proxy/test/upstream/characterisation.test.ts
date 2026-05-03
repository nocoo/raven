/**
 * Phase E.2 — drives every existing services/* call against a mocked
 * fetch and asserts the on-wire request shape matches the frozen
 * upstream-fixtures.ts entries. Re-run by E.3–E.8 against the new
 * upstream/* clients with the same fixture file as the diff target.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { state } from "../../src/lib/state"
import {
  CopilotOpenAIClient,
  defaultCopilotOpenAIConfig,
} from "../../src/upstream/copilot-openai"
import {
  CopilotNativeClient,
  defaultCopilotNativeConfig,
} from "../../src/upstream/copilot-native"
import {
  CopilotResponsesClient,
  defaultCopilotResponsesConfig,
} from "../../src/upstream/copilot-responses"
import {
  CopilotEmbeddingsClient,
  defaultCopilotEmbeddingsConfig,
} from "../../src/upstream/copilot-embeddings"
import {
  CustomOpenAIClient,
  defaultCustomOpenAIConfig,
} from "../../src/upstream/custom-openai"
import {
  CustomAnthropicClient,
  defaultCustomAnthropicConfig,
} from "../../src/upstream/custom-anthropic"
import type { CompiledProvider } from "../../src/db/providers"
import {
  upstreamCharacterisations,
  type CharacterisationEntry,
} from "./__characterisation__/upstream-fixtures"

interface CapturedRequest {
  url: string
  method: string
  proxy: string | null
  headers: Record<string, string>
  body: unknown
}

function normaliseHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : v
    })
    return out
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : v
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : (v as string)
  }
  return out
}

function captureFetch(): { spy: ReturnType<typeof vi.spyOn>; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit & { proxy?: string },
  ) => {
    const url = typeof input === "string" ? input : input.toString()
    const bodyText = typeof init?.body === "string" ? init.body : ""
    captured.push({
      url,
      method: init?.method ?? "GET",
      proxy: init?.proxy ?? null,
      headers: normaliseHeaders(init?.headers),
      body: bodyText ? JSON.parse(bodyText) : null,
    })
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    )
  }) as typeof fetch)
  return { spy, captured }
}

function applyState(s: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(s)) {
    ;(state as unknown as Record<string, unknown>)[k] = v
  }
}

const SAVED = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  copilotChatVersion: state.copilotChatVersion,
}

let spy: ReturnType<typeof vi.spyOn>
let captured: CapturedRequest[]

beforeEach(() => {
  ;({ spy, captured } = captureFetch())
})

afterEach(() => {
  spy.mockRestore()
  state.copilotToken = SAVED.copilotToken
  state.vsCodeVersion = SAVED.vsCodeVersion
  state.accountType = SAVED.accountType
  state.copilotChatVersion = SAVED.copilotChatVersion
})

function findFixture(id: string): CharacterisationEntry {
  const f = upstreamCharacterisations.find((e) => e.id === id)
  if (!f) throw new Error(`fixture not found: ${id}`)
  return f
}

function expectMatches(actual: CapturedRequest, expected: CharacterisationEntry["request"]): void {
  expect(actual.url).toBe(expected.url)
  expect(actual.method).toBe(expected.method)
  expect(actual.proxy).toBe(expected.proxy)
  expect(actual.body).toEqual(expected.body)
  // Compare headers as a sorted object so order-of-keys does not matter.
  const sortedActual = Object.fromEntries(
    Object.entries(actual.headers).sort(([a], [b]) => a.localeCompare(b)),
  )
  const sortedExpected = Object.fromEntries(
    Object.entries(expected.headers).sort(([a], [b]) => a.localeCompare(b)),
  )
  expect(sortedActual).toEqual(sortedExpected)
}

describe("upstream characterisation (E.2)", () => {
  test("copilot-openai/non-stream", async () => {
    const f = findFixture("copilot-openai/non-stream")
    applyState(f.input.state)
    const client = new CopilotOpenAIClient(defaultCopilotOpenAIConfig())
    await client.send(f.input.payload as Parameters<typeof client.send>[0])
    expect(captured).toHaveLength(1)
    expectMatches(captured[0]!, f.request)
  })

  test("copilot-openai/agent-call", async () => {
    const f = findFixture("copilot-openai/agent-call")
    applyState(f.input.state)
    const client = new CopilotOpenAIClient(defaultCopilotOpenAIConfig())
    await client.send(f.input.payload as Parameters<typeof client.send>[0])
    expectMatches(captured[0]!, f.request)
  })

  test("copilot-native/basic", async () => {
    const f = findFixture("copilot-native/basic")
    applyState(f.input.state)
    const client = new CopilotNativeClient(defaultCopilotNativeConfig())
    await client.send({
      payload: f.input.payload as never,
      options: f.input.options as never,
    })
    expectMatches(captured[0]!, f.request)
  })

  test("copilot-responses/basic", async () => {
    const f = findFixture("copilot-responses/basic")
    applyState(f.input.state)
    const client = new CopilotResponsesClient(defaultCopilotResponsesConfig())
    await client.send(f.input.payload as Parameters<typeof client.send>[0])
    expectMatches(captured[0]!, f.request)
  })

  test("copilot-embeddings/basic", async () => {
    const f = findFixture("copilot-embeddings/basic")
    applyState(f.input.state)
    const client = new CopilotEmbeddingsClient(defaultCopilotEmbeddingsConfig())
    await client.send(f.input.payload as Parameters<typeof client.send>[0])
    expectMatches(captured[0]!, f.request)
  })

  test("custom-openai/basic", async () => {
    const f = findFixture("custom-openai/basic")
    applyState(f.input.state)
    const client = new CustomOpenAIClient(defaultCustomOpenAIConfig())
    await client.send({
      provider: f.input.provider as unknown as CompiledProvider,
      payload: f.input.payload as never,
    })
    expectMatches(captured[0]!, f.request)
  })

  test("custom-openai/trailing-slash", async () => {
    const f = findFixture("custom-openai/trailing-slash")
    applyState(f.input.state)
    const client = new CustomOpenAIClient(defaultCustomOpenAIConfig())
    await client.send({
      provider: f.input.provider as unknown as CompiledProvider,
      payload: f.input.payload as never,
    })
    expectMatches(captured[0]!, f.request)
  })

  test("custom-anthropic/basic", async () => {
    const f = findFixture("custom-anthropic/basic")
    applyState(f.input.state)
    const client = new CustomAnthropicClient(defaultCustomAnthropicConfig())
    await client.send({
      provider: f.input.provider as unknown as CompiledProvider,
      payload: f.input.payload as never,
    })
    expectMatches(captured[0]!, f.request)
  })
})
