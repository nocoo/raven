// H.3 — composition/strategy-registry tests.
import { describe, expect, test } from "bun:test"

import {
  buildStrategy,
  StrategyNotRegisteredError,
} from "../../src/composition/strategy-registry"
import type { StrategyDecision, StrategyName } from "../../src/core/router"

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

  test.each([
    "copilot-native",
    "copilot-translated",
    "copilot-responses",
    "custom-openai",
    "custom-anthropic",
  ] satisfies StrategyName[])("throws StrategyNotRegisteredError for %s (pre-H.7+)", (name) => {
    expect(() =>
      buildStrategy({ kind: "ok", name } as StrategyDecision, { toolCallDebug: false }),
    ).toThrow(StrategyNotRegisteredError)
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
