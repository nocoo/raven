/**
 * Refactor E2E scenario skeleton — iterates the §4.3 matrix from
 * scenarios.json. These tests remain `.skip` placeholders; Phase C
 * fills them in and captures golden SSE + request_end fixtures.
 *
 * Run with anti-ban suspended (§1.2): `bun run test:e2e:full`. This suite
 * is NEVER auto-run in CI or pre-commit — manual only.
 */
import { describe, test, beforeAll, setDefaultTimeout } from "bun:test"
import { isProxyReachable, API_KEY } from "./helpers"
import { allStrategies, scenarioLabel } from "./scenarios"

setDefaultTimeout(120_000)

let proxyUp = false
beforeAll(async () => {
  proxyUp = await isProxyReachable()
  if (!proxyUp) {
    console.warn("Refactor E2E suite skipped: proxy not reachable on :7024")
  } else if (!API_KEY) {
    console.warn("Refactor E2E suite skipped: RAVEN_API_KEY not set")
  }
})

const filled = (): boolean =>
  proxyUp && API_KEY !== "" && process.env.RAVEN_CAPTURE_GOLDENS !== undefined

describe("refactor E2E — scenario skeleton (§4.3)", () => {
  for (const { name, scenarios } of allStrategies()) {
    describe(name, () => {
      for (const s of scenarios) {
        test.skipIf(!filled())(scenarioLabel(s), () => {
          // Filled in Phase C per strategy.
        })
      }
    })
  }
})
