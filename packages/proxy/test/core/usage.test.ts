import { describe, expect, test } from "vitest"
import { createUsageCollector, normalizeUsage, usageTotal, type UsageProtocol } from "../../src/core/usage"

describe("quota usage normalization", () => {
  test.each([
    ["openai", { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } }],
    ["responses", { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 90 } }],
    ["anthropic", { input_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 100 }],
  ] as const)("does not double count caches/reasoning for %s", (protocol, raw) => {
    const usage = normalizeUsage(protocol, raw)
    expect(usageTotal(usage)).toBe(1100)
    expect(usage).toEqual({ input_tokens: 200, cache_read_tokens: 800, cache_write_tokens: 0, output_tokens: 100, complete: true, usage_present: true })
  })

  test("Anthropic cache creation is a separate input category", () => {
    expect(usageTotal(normalizeUsage("anthropic", { input_tokens: 100, cache_creation_input_tokens: 25, output_tokens: 10 }))).toBe(135)
  })

  test.each(["openai", "anthropic", "responses", "embeddings"] as const)("distinguishes missing and zero %s usage", (protocol) => {
    const absent = normalizeUsage(protocol, null)
    expect(absent.complete).toBe(false)
    expect(absent.usage_present).toBe(false)
    expect(absent.input_tokens).toBeNull()
    expect(usageTotal(absent)).toBe(0)
    const zero = normalizeUsage(protocol, { input_tokens: 0, output_tokens: 0, prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(zero.complete).toBe(true)
    expect(zero.usage_present).toBe(true)
    expect(usageTotal(zero)).toBe(0)
  })

  test.each([undefined, [], "invalid", 3])("rejects malformed usage %j", (value) => {
    expect(normalizeUsage("openai", value).usage_present).toBe(false)
  })

  test("retains observed categories when fields are invalid", () => {
    expect(normalizeUsage("openai", { prompt_tokens: 20, completion_tokens: -1, prompt_tokens_details: { cached_tokens: "10" } })).toMatchObject({ input_tokens: 20, cache_read_tokens: null, output_tokens: null, complete: false })
    expect(normalizeUsage("responses", { input_tokens: Infinity, output_tokens: NaN }).complete).toBe(false)
    expect(normalizeUsage("anthropic", { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: -2 }).complete).toBe(false)
    expect(normalizeUsage("openai", { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 20 } })).toMatchObject({ input_tokens: 0, cache_read_tokens: 10, complete: false })
    expect(normalizeUsage("embeddings", { prompt_tokens: 8 })).toMatchObject({ input_tokens: 8, output_tokens: 0, complete: true })
  })

  test.each(["openai", "responses"] as const)("charges observed %s cached input when the inclusive total is absent", (protocol) => {
    const raw = protocol === "responses"
      ? { input_tokens_details: { cached_tokens: 800 }, output_tokens: 100 }
      : { prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 100 }
    const usage = normalizeUsage(protocol, raw)
    expect(usage).toMatchObject({ input_tokens: null, cache_read_tokens: 800, cache_write_tokens: null, output_tokens: 100, complete: false })
    expect(usageTotal(usage)).toBe(900)
  })

  test("does not invent zero values for omitted Anthropic cache categories", () => {
    const usage = normalizeUsage("anthropic", { input_tokens: 10, output_tokens: 3 })
    expect(usage).toMatchObject({ cache_read_tokens: null, cache_write_tokens: null, complete: false })
    expect(usageTotal(usage)).toBe(13)
  })
})

describe("per-attempt usage collector", () => {
  test("counts cumulative streaming counters once across byte and CRLF boundaries", () => {
    const collector = createUsageCollector("openai", true)
    const stream = ': heartbeat\r\ndata: {"usage":{"prompt_tokens":20,"completion_tokens":2}}\r\n\r\ndata:{"usage":{"prompt_tokens":20,"completion_tokens":9}}\ndata: \n\ndata: [DONE]'
    for (const character of stream) collector.push(character)
    const usage = collector.finish(true)
    expect(usageTotal(usage)).toBe(29)
    expect(usage.complete).toBe(true)
  })

  test("combines Anthropic start input and final delta output", () => {
    const collector = createUsageCollector("anthropic", true)
    collector.push('data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}}\r\r')
    collector.push('data: {"usage":{"output_tokens":6}}\n\ndata: {"type":"message_stop"}\n\n')
    expect(collector.finish(true)).toMatchObject({ input_tokens: 10, output_tokens: 6, complete: true })
  })

  test.each(["response.completed", "response.incomplete", "response.failed"])("observes usage on %s", (type) => {
    const collector = createUsageCollector("responses", true)
    collector.push(`event: ${type}\ndata: ${JSON.stringify({ type, response: { usage: { input_tokens: 15, output_tokens: 3 } } })}\n\n`)
    expect(collector.finish(true)).toMatchObject({ input_tokens: 15, output_tokens: 3, complete: true })
  })

  test.each(["response.completed", "response.incomplete", "response.failed"])("accepts a terminal %s event without a redundant JSON type", (event) => {
    const collector = createUsageCollector("responses", true)
    collector.push(`event: ${event}\ndata: {"response":{"usage":{"input_tokens":15,"output_tokens":3}}}\n\n`)
    expect(collector.finish(false)).toMatchObject({ input_tokens: 15, output_tokens: 3, complete: true })
  })

  test("resets event names between SSE frames", () => {
    const collector = createUsageCollector("responses", true)
    collector.push('event: response.completed\n\ndata: {"response":{"usage":{"input_tokens":15,"output_tokens":3}}}\n\n')
    expect(collector.finish(true).complete).toBe(false)
  })

  test.each([false, true])("marks unterminated or cancelled streams incomplete (completed=%s)", (completed) => {
    const collector = createUsageCollector("openai", true)
    collector.push('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n')
    expect(collector.finish(completed)).toMatchObject({ input_tokens: 1, output_tokens: 2, complete: false })
  })

  test.each(["openai", "responses", "anthropic", "embeddings"] as UsageProtocol[])("observes JSON %s without rewriting the body", (protocol) => {
    const collector = createUsageCollector(protocol, false)
    const raw = JSON.stringify({ usage: { prompt_tokens: 1, input_tokens: 1, completion_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    collector.push(raw.slice(0, 7))
    collector.push(raw.slice(7))
    expect(collector.finish(true).complete).toBe(true)
  })

  test("does not turn malformed output into a parsing error or claim absent usage is present", () => {
    const collector = createUsageCollector("openai", true)
    collector.push('data: broken\n\ndata: null\n\ndata: {"choices":[]}\n\ndata: [DONE]\n\n')
    expect(collector.finish(true)).toMatchObject({ usage_present: false, complete: false })
    const unknown = createUsageCollector("openai", false)
    unknown.push('{"usage":{}}')
    expect(unknown.finish(false)).toMatchObject({ usage_present: true, complete: false })
  })
})
