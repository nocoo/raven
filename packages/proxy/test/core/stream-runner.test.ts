import { describe, expect, test } from "bun:test"

import {
  computeStreamTimings,
  openAIUsageFrom,
  parseSseData,
} from "../../src/core/stream-runner"

describe("core/stream-runner — parseSseData", () => {
  test("returns null for [DONE] terminator", () => {
    expect(parseSseData("[DONE]")).toBeNull()
    expect(parseSseData(" [DONE] ")).toBeNull()
  })

  test("returns null for empty / whitespace / null / undefined", () => {
    expect(parseSseData("")).toBeNull()
    expect(parseSseData("   ")).toBeNull()
    expect(parseSseData(null)).toBeNull()
    expect(parseSseData(undefined)).toBeNull()
  })

  test("returns null for malformed JSON (does not throw)", () => {
    expect(parseSseData("{not json")).toBeNull()
    expect(parseSseData("undefined")).toBeNull()
  })

  test("returns parsed object for valid JSON", () => {
    expect(parseSseData('{"a":1,"b":[2]}')).toEqual({ a: 1, b: [2] })
  })

  test("trims surrounding whitespace before parsing", () => {
    expect(parseSseData('  {"x":true}  ')).toEqual({ x: true })
  })
})

describe("core/stream-runner — computeStreamTimings", () => {
  test("with firstChunkTime: ttft and processing both set", () => {
    const t = computeStreamTimings(100, 150, 200)
    expect(t).toEqual({ latencyMs: 100, ttftMs: 50, processingMs: 50 })
  })

  test("without firstChunkTime: ttft and processing are null, latency still set", () => {
    const t = computeStreamTimings(100, null, 200)
    expect(t).toEqual({ latencyMs: 100, ttftMs: null, processingMs: null })
  })

  test("rounds non-integer ms values", () => {
    const t = computeStreamTimings(100.4, 150.6, 200.5)
    expect(t).toEqual({ latencyMs: 100, ttftMs: 50, processingMs: 50 })
  })

  test("defaults endTime to performance.now() when omitted", () => {
    const before = performance.now()
    const t = computeStreamTimings(before, null)
    const after = performance.now()
    expect(t.latencyMs).toBeGreaterThanOrEqual(0)
    expect(t.latencyMs).toBeLessThanOrEqual(Math.round(after - before) + 1)
  })
})

describe("core/stream-runner — openAIUsageFrom", () => {
  test("returns null for missing / non-object input", () => {
    expect(openAIUsageFrom(null)).toBeNull()
    expect(openAIUsageFrom(undefined)).toBeNull()
    expect(openAIUsageFrom("string")).toBeNull()
    expect(openAIUsageFrom(42)).toBeNull()
  })

  test("returns null for empty object (no prompt/completion fields)", () => {
    expect(openAIUsageFrom({})).toBeNull()
  })

  test("subtracts cached_tokens from prompt_tokens", () => {
    expect(openAIUsageFrom({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 },
    })).toEqual({ inputTokens: 70, outputTokens: 20 })
  })

  test("zero cached_tokens by default", () => {
    expect(openAIUsageFrom({
      prompt_tokens: 50,
      completion_tokens: 10,
    })).toEqual({ inputTokens: 50, outputTokens: 10 })
  })

  test("missing fields default to zero (but block is non-empty)", () => {
    expect(openAIUsageFrom({ completion_tokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
    })
    expect(openAIUsageFrom({ prompt_tokens: 5 })).toEqual({
      inputTokens: 5,
      outputTokens: 0,
    })
  })
})
