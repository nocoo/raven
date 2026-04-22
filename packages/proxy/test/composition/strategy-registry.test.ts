// H.3 — composition/strategy-registry tests.
import { describe, expect, test } from "bun:test"

import { buildStrategy } from "../../src/composition/strategy-registry"
import type { StrategyDecision } from "../../src/core/router"

describe("composition/strategy-registry", () => {
  test("returns a Strategy with name=copilot-openai-direct for ok decision", () => {
    const decision: StrategyDecision = { kind: "ok", name: "copilot-openai-direct" }
    const s = buildStrategy(decision, { toolCallDebug: false })
    expect(s.name).toBe("copilot-openai-direct")
    expect(typeof s.prepare).toBe("function")
    expect(typeof s.dispatch).toBe("function")
    expect(typeof s.adaptJson).toBe("function")
    expect(typeof s.adaptChunk).toBe("function")
    expect(typeof s.adaptStreamError).toBe("function")
    expect(typeof s.describeEndLog).toBe("function")
    expect(typeof s.initStreamState).toBe("function")
  })

  test("returns a Strategy with name=copilot-native for ok decision", () => {
    const decision: StrategyDecision = { kind: "ok", name: "copilot-native" }
    const s = buildStrategy(decision, { toolCallDebug: false })
    expect(s.name).toBe("copilot-native")
    expect(typeof s.prepare).toBe("function")
    expect(typeof s.dispatch).toBe("function")
    expect(typeof s.adaptJson).toBe("function")
    expect(typeof s.adaptChunk).toBe("function")
    expect(typeof s.adaptStreamError).toBe("function")
    expect(typeof s.describeEndLog).toBe("function")
    expect(typeof s.initStreamState).toBe("function")
  })

  test("returns a Strategy with name=copilot-responses for ok decision", () => {
    const decision: StrategyDecision = { kind: "ok", name: "copilot-responses" }
    const s = buildStrategy(decision, { toolCallDebug: false })
    expect(s.name).toBe("copilot-responses")
    expect(typeof s.prepare).toBe("function")
    expect(typeof s.dispatch).toBe("function")
    expect(typeof s.adaptJson).toBe("function")
    expect(typeof s.adaptChunk).toBe("function")
    expect(typeof s.adaptStreamError).toBe("function")
    expect(typeof s.describeEndLog).toBe("function")
    expect(typeof s.initStreamState).toBe("function")
  })

  test("returns a Strategy with name=custom-openai for ok decision", () => {
    const decision: StrategyDecision = { kind: "ok", name: "custom-openai" }
    const s = buildStrategy(decision, { toolCallDebug: false, filterWhitespaceChunks: false })
    expect(s.name).toBe("custom-openai")
    expect(typeof s.prepare).toBe("function")
    expect(typeof s.dispatch).toBe("function")
    expect(typeof s.adaptJson).toBe("function")
    expect(typeof s.adaptChunk).toBe("function")
    expect(typeof s.adaptStreamError).toBe("function")
    expect(typeof s.describeEndLog).toBe("function")
    expect(typeof s.initStreamState).toBe("function")
  })

  test("returns a Strategy with name=custom-anthropic for ok decision", () => {
    const decision: StrategyDecision = { kind: "ok", name: "custom-anthropic" }
    const s = buildStrategy(decision, { toolCallDebug: false })
    expect(s.name).toBe("custom-anthropic")
    expect(typeof s.prepare).toBe("function")
    expect(typeof s.dispatch).toBe("function")
    expect(typeof s.adaptJson).toBe("function")
    expect(typeof s.adaptChunk).toBe("function")
    expect(typeof s.adaptStreamError).toBe("function")
    expect(typeof s.describeEndLog).toBe("function")
    expect(typeof s.initStreamState).toBe("function")
  })

  test("throws on non-ok decision (route must reject before reaching here)", () => {
    const reject: StrategyDecision = {
      kind: "reject",
      status: 400,
      errorType: "invalid_request_error",
      message: "x",
    }
    expect(() => buildStrategy(reject, { toolCallDebug: false })).toThrow(
      /non-ok decision/,
    )
  })

  test("returns a Strategy with name=copilot-translated for ok decision", () => {
    const decision: StrategyDecision = { kind: "ok", name: "copilot-translated" }
    const s = buildStrategy(decision, { toolCallDebug: false, filterWhitespaceChunks: false })
    expect(s.name).toBe("copilot-translated")
    expect(typeof s.prepare).toBe("function")
    expect(typeof s.dispatch).toBe("function")
    expect(typeof s.adaptJson).toBe("function")
    expect(typeof s.adaptChunk).toBe("function")
    expect(typeof s.adaptStreamError).toBe("function")
    expect(typeof s.describeEndLog).toBe("function")
    expect(typeof s.initStreamState).toBe("function")
  })

  test("toolCallDebug is plumbed through to the strategy (no separate accessor; checked indirectly)", () => {
    // The strategy honours toolCallDebug in adaptChunk + describeEndLog.
    // We assert by constructing both and checking the name only here; the
    // strategy's own tests (H.2) cover behavioural propagation.
    const a = buildStrategy({ kind: "ok", name: "copilot-openai-direct" }, { toolCallDebug: true })
    const b = buildStrategy({ kind: "ok", name: "copilot-openai-direct" }, { toolCallDebug: false })
    expect(a.name).toBe("copilot-openai-direct")
    expect(b.name).toBe("copilot-openai-direct")
  })
})
