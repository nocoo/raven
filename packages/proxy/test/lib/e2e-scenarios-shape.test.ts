/**
 * Shape-validation for test/e2e/refactor/scenarios.json.
 *
 * The E2E scenario matrix itself only runs with real upstream
 * credentials, but the JSON structure must stay valid at every
 * commit so Phase C's golden capture and Phase H's fixture loader
 * don't silently break. This L1 test parses the file and checks
 * invariants that the JSON schema can't easily express (unique
 * golden paths, each strategy has ≥1 scenario, etc.).
 */
import { describe, expect, test } from "bun:test"
import {
  allStrategies,
  scenariosFor,
  scenarioLabel,
  type StrategyName,
} from "../../test/e2e/refactor/scenarios"

const EXPECTED_STRATEGIES: StrategyName[] = [
  "CopilotNative",
  "CopilotTranslated",
  "CopilotOpenAIDirect",
  "CopilotResponses",
  "CustomOpenAI",
  "CustomAnthropic",
]

describe("e2e/refactor scenarios.json", () => {
  test("covers all six §4.3 strategies, in order", () => {
    const names = allStrategies().map((s) => s.name)
    expect(names).toEqual(EXPECTED_STRATEGIES)
  })

  test("each strategy has at least one scenario", () => {
    for (const s of allStrategies()) {
      expect(s.scenarios.length).toBeGreaterThan(0)
    }
  })

  test("golden paths are unique across the whole matrix", () => {
    const paths = allStrategies().flatMap((s) => s.scenarios.map((sc) => sc.goldenPath))
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i)
    expect(dupes).toEqual([])
  })

  test("every scenario has at least one of: stream flag, features list, or model", () => {
    for (const s of allStrategies()) {
      for (const sc of s.scenarios) {
        expect(sc.model.length).toBeGreaterThan(0)
        expect(Array.isArray(sc.features)).toBe(true)
        expect(typeof sc.stream).toBe("boolean")
      }
    }
  })

  test("scenariosFor returns the right entry, throws on unknown", () => {
    expect(scenariosFor("CopilotNative").length).toBeGreaterThan(0)
    expect(() => scenariosFor("Nope" as StrategyName)).toThrow()
  })

  test("scenarioLabel is deterministic and includes model + stream suffix", () => {
    const s = { model: "m", stream: true, features: ["tool_use"], goldenPath: "x/y.json" }
    expect(scenarioLabel(s)).toBe("m-tool_use-stream")
    expect(scenarioLabel({ ...s, stream: false })).toBe("m-tool_use-nonstream")
    expect(scenarioLabel({ ...s, features: [] })).toBe("m-stream")
  })
})
