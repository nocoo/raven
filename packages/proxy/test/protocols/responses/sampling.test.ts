import { describe, expect, test } from "vitest"

import { sanitizeCopilotResponsesSampling } from "../../../src/protocols/responses/sampling"
import type { ResponsesPayload } from "../../../src/upstream/copilot-responses"

function req(over: Record<string, unknown> = {}): ResponsesPayload {
  return { model: "gpt-5.4", input: "hi", ...over } as ResponsesPayload
}

describe("sanitizeCopilotResponsesSampling", () => {
  test("drops temperature when gpt-5 and effort omitted", () => {
    const out = sanitizeCopilotResponsesSampling(req({ temperature: 0.7 }))
    expect(out.temperature).toBeUndefined()
  })

  test("keeps temperature=1 when effort omitted", () => {
    const input = req({ temperature: 1 })
    const out = sanitizeCopilotResponsesSampling(input)
    expect(out).toBe(input)
    expect(out.temperature).toBe(1)
  })

  test("keeps non-default temperature when effort is none", () => {
    const input = req({ temperature: 0.7, reasoning: { effort: "none" } })
    const out = sanitizeCopilotResponsesSampling(input)
    expect(out).toBe(input)
    expect(out.temperature).toBe(0.7)
  })

  test("drops top_p when effort omitted, including top_p=1", () => {
    expect(sanitizeCopilotResponsesSampling(req({ top_p: 0.9 })).top_p).toBeUndefined()
    expect(sanitizeCopilotResponsesSampling(req({ top_p: 1 })).top_p).toBeUndefined()
  })

  test("keeps top_p when effort is none", () => {
    const input = req({ top_p: 0.9, reasoning: { effort: "none" } })
    expect(sanitizeCopilotResponsesSampling(input)).toBe(input)
  })

  test("mixed temperature=1 and top_p=0.9 drops only top_p", () => {
    const input = req({ temperature: 1, top_p: 0.9 })
    const out = sanitizeCopilotResponsesSampling(input)
    expect(out).not.toBe(input)
    expect(out.temperature).toBe(1)
    expect(out.top_p).toBeUndefined()
    expect(input.top_p).toBe(0.9)
  })

  test("does not strip grok or gpt-4o", () => {
    const grok = req({ model: "grok-4.6", temperature: 0.7 })
    const gpt4o = req({ model: "gpt-4o", temperature: 0.7 })
    expect(sanitizeCopilotResponsesSampling(grok)).toBe(grok)
    expect(sanitizeCopilotResponsesSampling(gpt4o)).toBe(gpt4o)
  })

  test("delimited gpt-5 family; rejects gpt-50 and gpt-5chat", () => {
    expect(sanitizeCopilotResponsesSampling(req({ model: "gpt-5", temperature: 0.2 })).temperature).toBeUndefined()
    expect(sanitizeCopilotResponsesSampling(req({ model: "gpt-5-mini", temperature: 0.2 })).temperature).toBeUndefined()
    const gpt50 = req({ model: "gpt-50", temperature: 0.2 })
    const gpt5chat = req({ model: "gpt-5chat", temperature: 0.2 })
    expect(sanitizeCopilotResponsesSampling(gpt50)).toBe(gpt50)
    expect(sanitizeCopilotResponsesSampling(gpt5chat)).toBe(gpt5chat)
  })

  test("provider prefix uses last path segment", () => {
    expect(
      sanitizeCopilotResponsesSampling(req({ model: "openai/gpt-5.6-sol", temperature: 0.2 })).temperature,
    ).toBeUndefined()
  })

  test("non-string model is a no-op", () => {
    const input = { model: 1, temperature: 0.7 } as unknown as ResponsesPayload
    expect(sanitizeCopilotResponsesSampling(input)).toBe(input)
  })

  test("null and array payloads are no-ops", () => {
    expect(sanitizeCopilotResponsesSampling(null as unknown as ResponsesPayload)).toBeNull()
    const arr = [] as unknown as ResponsesPayload
    expect(sanitizeCopilotResponsesSampling(arr)).toBe(arr)
  })

  test("malformed reasoning is treated as omitted effort", () => {
    expect(sanitizeCopilotResponsesSampling(req({ temperature: 0.7, reasoning: "none" })).temperature).toBeUndefined()
    expect(sanitizeCopilotResponsesSampling(req({ temperature: 0.7, reasoning: null })).temperature).toBeUndefined()
    expect(sanitizeCopilotResponsesSampling(req({ temperature: 0.7, reasoning: [] })).temperature).toBeUndefined()
  })
})
