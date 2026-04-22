/**
 * Scenario matrix loader — single source of truth for the §4.3 table.
 *
 * Consumed by:
 *   - test/e2e/refactor/scenarios.test.ts (.skip placeholders)
 *   - Phase C golden capture pipeline
 *   - Phase H adaptChunk unit fixtures (via B.5 fixture format)
 *
 * Keeping the data in JSON (not inline in TS) means the capture-goldens
 * script and downstream scripts can parse it without importing the test
 * file, and the JSON schema validates the shape.
 */
import scenariosJson from "./scenarios.json" with { type: "json" }

export type StrategyName =
  | "CopilotNative"
  | "CopilotTranslated"
  | "CopilotOpenAIDirect"
  | "CopilotResponses"
  | "CustomOpenAI"
  | "CustomAnthropic"

export interface Scenario {
  model: string
  stream: boolean
  features: string[]
  goldenPath: string
}

export interface StrategyEntry {
  name: StrategyName
  scenarios: Scenario[]
}

interface ScenariosFile {
  strategies: StrategyEntry[]
}

const data = scenariosJson as unknown as ScenariosFile

export function allStrategies(): StrategyEntry[] {
  return data.strategies
}

export function scenariosFor(name: StrategyName): Scenario[] {
  const entry = data.strategies.find((s) => s.name === name)
  if (!entry) throw new Error(`unknown strategy: ${name}`)
  return entry.scenarios
}

/** Short test-name tag: `<model>[-<feature>]-<stream|nonstream>`. */
export function scenarioLabel(s: Scenario): string {
  const streamTag = s.stream ? "stream" : "nonstream"
  const feat = s.features.length > 0 ? `-${s.features.join("+")}` : ""
  return `${s.model}${feat}-${streamTag}`
}
