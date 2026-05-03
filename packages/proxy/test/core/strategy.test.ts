import { describe, expect, test } from "vitest"

import { STRATEGY_NAMES, isStrategyName } from "../../src/core/strategy"

describe("core/strategy", () => {
  test("STRATEGY_NAMES enumerates every shipped strategy (§3.2)", () => {
    expect([...STRATEGY_NAMES].sort()).toEqual([
      "copilot-native",
      "copilot-openai-direct",
      "copilot-responses",
      "copilot-translated",
      "custom-anthropic",
      "custom-openai",
    ])
    // §1.1: exactly 6 strategies as of this doc.
    expect(STRATEGY_NAMES.length).toBe(6)
  })

  test("isStrategyName accepts known + rejects unknown", () => {
    for (const n of STRATEGY_NAMES) expect(isStrategyName(n)).toBe(true)
    expect(isStrategyName("not-a-strategy")).toBe(false)
    expect(isStrategyName("")).toBe(false)
    expect(isStrategyName("copilot-translated ")).toBe(false)
  })
})
