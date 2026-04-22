/**
 * Refactor E2E scenario driver — iterates the §4.3 matrix from
 * scenarios.json and either captures or diffs each scenario's golden
 * fixture.
 *
 * Run manually only (§1.2 anti-ban protocol suspended for Phase C):
 *   RAVEN_API_KEY=... bun test packages/proxy/test/e2e/refactor/scenarios.test.ts
 *   RAVEN_API_KEY=... RAVEN_CAPTURE_GOLDENS=1 bun test ...   # re-capture
 *
 * The suite is NEVER auto-run in CI or pre-commit — `bun run test:e2e`
 * is the manual entry point. It short-circuits if the proxy is not
 * reachable or RAVEN_API_KEY is unset.
 *
 * Per §4.3, C.5/C.6 (Custom*) scenarios require DB provider rows that
 * may not be configured on every machine. Those are listed in
 * CUSTOM_STRATEGIES and gated by RAVEN_CUSTOM_READY=1.
 */
import { describe, test, beforeAll, expect, setDefaultTimeout } from "bun:test"
import { headers, isProxyReachable, PROXY, API_KEY } from "./helpers"
import { allStrategies, scenarioLabel, type Scenario, type StrategyName } from "./scenarios"
import { buildScenarioRequest } from "./request-builder"
import { captureOrDiffFixture } from "./capture"

setDefaultTimeout(120_000)

const CUSTOM_STRATEGIES = new Set<StrategyName>(["CustomOpenAI", "CustomAnthropic"])
const CUSTOM_READY = process.env.RAVEN_CUSTOM_READY === "1"

// skipIf evaluates at describe-time, so the gate must be synchronous.
// Reachability is verified in beforeAll and surfaces as a hard fail if
// the key was supplied but the proxy turned out to be unreachable.
const HAS_KEY = API_KEY !== ""
const strategyReady = (name: StrategyName): boolean =>
  HAS_KEY && (!CUSTOM_STRATEGIES.has(name) || CUSTOM_READY)

beforeAll(async () => {
  if (!HAS_KEY) {
    console.warn("Refactor E2E suite skipped: RAVEN_API_KEY not set")
    return
  }
  const up = await isProxyReachable()
  if (!up) throw new Error(`proxy not reachable on ${PROXY}`)
})

async function runScenario(name: StrategyName, s: Scenario): Promise<void> {
  const request = buildScenarioRequest(name, s)
  const url = `${PROXY}${request.path}`

  const res = await captureOrDiffFixture({
    scenario: { goldenPath: s.goldenPath, model: s.model },
    request,
    fetchResponse: async () =>
      await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(request.body),
      }),
  })

  if (res.mode === "capture") {
    expect(res.live.fixtureVersion).toBe(1)
    expect(res.live.expected_end_log.statusCode).toBeGreaterThanOrEqual(200)
    return
  }

  // Diff mode: require a stored fixture (capture it first) and assert
  // that the invariant slots of the live run match what was stored.
  // Raw upstream chunks are NOT compared byte-for-byte — upstream
  // varies model id / ids / timestamps per call. Only structural
  // fields in expected_end_log are asserted here; deeper SSE-shape
  // diffing is Phase H's job (adaptChunk unit tests).
  expect(res.stored).not.toBeNull()
  const stored = res.stored!
  expect(res.live.expected_end_log.path).toBe(stored.expected_end_log.path)
  expect(res.live.expected_end_log.format).toBe(stored.expected_end_log.format)
  expect(res.live.expected_end_log.stream).toBe(stored.expected_end_log.stream)
  expect(res.live.expected_end_log.status).toBe(stored.expected_end_log.status)
}

describe("refactor E2E — scenario driver (§4.3)", () => {
  for (const { name, scenarios } of allStrategies()) {
    describe(name, () => {
      for (const s of scenarios) {
        test.skipIf(!strategyReady(name))(scenarioLabel(s), async () => {
          await runScenario(name, s)
        })
      }
    })
  }
})
