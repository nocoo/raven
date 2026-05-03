import { describe, expect, test } from "vitest"
import {
  extractNonStreamingMeta,
  extractResolvedModel,
  extractUsage,
  isTerminalResponseEvent,
} from "../../../src/protocols/responses/stream-state"

describe("isTerminalResponseEvent", () => {
  test("recognises terminal events", () => {
    expect(isTerminalResponseEvent("response.completed")).toBe(true)
    expect(isTerminalResponseEvent("response.done")).toBe(true)
    expect(isTerminalResponseEvent("response.incomplete")).toBe(true)
    expect(isTerminalResponseEvent("response.failed")).toBe(true)
  })

  test("rejects non-terminal events", () => {
    expect(isTerminalResponseEvent("response.created")).toBe(false)
    expect(isTerminalResponseEvent("response.output_text.delta")).toBe(false)
    expect(isTerminalResponseEvent("")).toBe(false)
    expect(isTerminalResponseEvent(null)).toBe(false)
    expect(isTerminalResponseEvent(undefined)).toBe(false)
  })
})

describe("extractResolvedModel", () => {
  test("returns model when present", () => {
    const data = JSON.stringify({ response: { model: "gpt-5" } })
    expect(extractResolvedModel(data)).toBe("gpt-5")
  })

  test("returns null when model missing", () => {
    expect(extractResolvedModel(JSON.stringify({ response: {} }))).toBeNull()
    expect(extractResolvedModel(JSON.stringify({}))).toBeNull()
  })

  test("returns null when model is not a string", () => {
    expect(extractResolvedModel(JSON.stringify({ response: { model: 42 } }))).toBeNull()
  })

  test("returns null for invalid JSON", () => {
    expect(extractResolvedModel("not-json")).toBeNull()
  })
})

describe("extractUsage", () => {
  test("returns usage tokens when present", () => {
    const data = JSON.stringify({
      response: { usage: { input_tokens: 42, output_tokens: 17 } },
    })
    expect(extractUsage(data)).toEqual({ inputTokens: 42, outputTokens: 17 })
  })

  test("defaults missing fields to 0", () => {
    expect(extractUsage(JSON.stringify({ response: { usage: {} } }))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(
      extractUsage(JSON.stringify({ response: { usage: { input_tokens: 5 } } })),
    ).toEqual({ inputTokens: 5, outputTokens: 0 })
  })

  test("coerces non-number fields to 0", () => {
    expect(
      extractUsage(
        JSON.stringify({ response: { usage: { input_tokens: "nope", output_tokens: null } } }),
      ),
    ).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  test("returns null when usage absent", () => {
    expect(extractUsage(JSON.stringify({ response: {} }))).toBeNull()
    expect(extractUsage(JSON.stringify({}))).toBeNull()
  })

  test("returns null for invalid JSON", () => {
    expect(extractUsage("{not json")).toBeNull()
  })
})

describe("extractNonStreamingMeta", () => {
  test("pulls model + usage from complete body", () => {
    const meta = extractNonStreamingMeta(
      { model: "gpt-5", usage: { input_tokens: 10, output_tokens: 20 } },
      "fallback",
    )
    expect(meta).toEqual({ resolvedModel: "gpt-5", inputTokens: 10, outputTokens: 20 })
  })

  test("falls back to given model when missing", () => {
    const meta = extractNonStreamingMeta({}, "fallback")
    expect(meta).toEqual({ resolvedModel: "fallback", inputTokens: 0, outputTokens: 0 })
  })

  test("handles null/undefined response", () => {
    expect(extractNonStreamingMeta(null, "fb")).toEqual({
      resolvedModel: "fb",
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(extractNonStreamingMeta(undefined, "fb")).toEqual({
      resolvedModel: "fb",
      inputTokens: 0,
      outputTokens: 0,
    })
  })

  test("coerces non-number usage fields to 0", () => {
    const meta = extractNonStreamingMeta(
      { model: 123, usage: { input_tokens: "x", output_tokens: undefined } },
      "fallback",
    )
    expect(meta).toEqual({ resolvedModel: "fallback", inputTokens: 0, outputTokens: 0 })
  })
})
