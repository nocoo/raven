/**
 * Re-capture golden fixtures for a single strategy (§4.3 + B.6).
 *
 * Usage:   bun run capture-goldens <strategy> [-- bun-test-args...]
 * Example: bun run capture-goldens CopilotNative
 *
 * Only the named strategy's scenarios run — other strategies are
 * filtered out so a Copilot rate-limit hit in one strategy can't
 * corrupt goldens for another. Existing fixtures for the target
 * strategy are overwritten by the refactor E2E suite when
 * RAVEN_CAPTURE_GOLDENS=1 is set.
 *
 * Prerequisites:
 *   - Proxy running on :7024 with valid upstream credentials.
 *   - RAVEN_API_KEY exported (see CLAUDE.md "Running E2E tests (L2)").
 *   - Custom-* strategies additionally require the provider rows to
 *     be configured in the database (Phase C.5/C.6 handle that).
 */
import scenariosJson from "../packages/proxy/test/e2e/refactor/scenarios.json" with { type: "json" }
import { $ } from "bun"
import { parseCaptureArgs, checkCaptureEnv } from "./lib/capture-goldens-args"

interface StrategyEntry { name: string }
interface ScenariosFile { strategies: StrategyEntry[] }

const validNames = (scenariosJson as unknown as ScenariosFile).strategies.map((s) => s.name)

const parsed = parseCaptureArgs(process.argv.slice(2), validNames)
if (!parsed.ok) {
  console.error(parsed.message)
  process.exit(parsed.exitCode)
}

const envCheck = checkCaptureEnv(process.env as Record<string, string | undefined>)
if (envCheck && !envCheck.ok) {
  console.error(envCheck.message)
  process.exit(envCheck.exitCode)
}

const health = await fetch("http://localhost:7024/health", {
  signal: AbortSignal.timeout(2_000),
}).catch(() => null)
if (!health?.ok) {
  console.error("proxy not reachable on :7024 — start it with `bun run dev:proxy`")
  process.exit(2)
}
void health.body?.cancel()

const { strategy, extra } = parsed.args
console.log(`🎯 Capturing goldens for strategy: ${strategy}`)
console.log(`   proxy ok · RAVEN_API_KEY set · RAVEN_CAPTURE_GOLDENS=1\n`)

// bun test's --test-name-pattern is a regex applied to the full nested
// name; "refactor E2E — scenario skeleton (§4.3) > <Strategy>" is the
// describe chain, so anchoring on the strategy name is enough.
const result = await $`bun test test/e2e/refactor/scenarios.test.ts --test-name-pattern=${strategy} ${extra}`
  .cwd(`${import.meta.dir}/../packages/proxy`)
  .env({
    ...process.env,
    RAVEN_CAPTURE_GOLDENS: "1",
    RAVEN_E2E_FULL: "1",
  })
  .nothrow()

process.exit(result.exitCode)
