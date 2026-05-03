/**
 * Coverage gate (§4.5 enforcement).
 *
 * Modes:
 *   - placeholder (A.1–A.6): only enforces the global floor from baseline.
 *   - enforce    (flipped in C.7): also blocks regressions beyond
 *     `regressionAllowanceAbsPct` vs the recorded baseline numbers.
 *
 * Usage:
 *   bun run scripts/check-coverage.ts                 # baseline-driven
 *   bun run scripts/check-coverage.ts --threshold=90  # legacy override
 *   bun run scripts/check-coverage.ts --skip-tests    # re-use existing lcov.info
 */

import { evaluateGate, loadBaseline, parseLcov } from "./lib/coverage"
import { Glob } from "bun"

const args = new Set(process.argv.slice(2))
const thresholdArg = [...args].find((a) => a.startsWith("--threshold="))
const explicitThreshold = thresholdArg ? Number(thresholdArg.slice("--threshold=".length)) : null
const skipTests = args.has("--skip-tests")
const REPO_ROOT = `${import.meta.dir}/..`
const BASELINE_PATH = `${REPO_ROOT}/docs/20-baseline.json`
const COV_DIR = `${REPO_ROOT}/packages/proxy/coverage`

let testCount: number | null = null

/**
 * Parse vitest's "Tests  N passed (N)" summary line. Vitest emits
 * "<count> <state>" segments (passed/failed/skipped/todo); sum them
 * to get the run total. Returns null if the line isn't present
 * (e.g. skipped-tests mode).
 */
function extractTestCount(output: string): number | null {
  const match = output.match(/Tests\s+([^\n]*?\))/)
  if (!match) return null
  let total = 0
  let saw = false
  for (const seg of match[1].matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
    total += Number(seg[1])
    saw = true
  }
  return saw ? total : null
}

/**
 * Enumerate every .ts file under packages/proxy/src, returning
 * paths relative to the proxy package root (matching vitest istanbul
 * lcov `SF:` format — e.g. `src/routes/messages/handler.ts`). Used
 * by the coverage gate to catch brand-new source files that no test
 * imports — those files are absent from lcov entirely.
 */
async function listProxySourceFiles(): Promise<string[]> {
  const proxyRoot = `${REPO_ROOT}/packages/proxy`
  const glob = new Glob("src/**/*.ts")
  const results: string[] = []
  for await (const p of glob.scan({ cwd: proxyRoot })) {
    if (p.endsWith(".d.ts")) continue
    results.push(p)
  }
  return results
}

async function runVitest(
  vitestArgs: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bunx", "--bun", "vitest", "run", ...vitestArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const decoder = new TextDecoder()
  let stdoutBuf = ""
  let stderrBuf = ""
  const stdoutReader = proc.stdout.getReader()
  const stderrReader = proc.stderr.getReader()
  const drainStdout = (async () => {
    while (true) {
      const { value, done } = await stdoutReader.read()
      if (done) break
      const chunk = decoder.decode(value)
      stdoutBuf += chunk
      process.stdout.write(chunk)
    }
  })()
  const drainStderr = (async () => {
    while (true) {
      const { value, done } = await stderrReader.read()
      if (done) break
      const chunk = decoder.decode(value)
      stderrBuf += chunk
      process.stderr.write(chunk)
    }
  })()

  const exitCode = await proc.exited
  await drainStdout
  await drainStderr
  return { exitCode, stdout: stdoutBuf, stderr: stderrBuf }
}

if (!skipTests) {
  // Scripts/lib tests live under the root vitest "scripts" project.
  const libRun = await runVitest(["--project", "scripts"], REPO_ROOT)
  if (libRun.exitCode !== 0) process.exit(libRun.exitCode)

  // Proxy L1 tests with coverage — vitest istanbul provider emits
  // lcov.info into packages/proxy/coverage/.
  const proxyRun = await runVitest(["--coverage"], `${REPO_ROOT}/packages/proxy`)
  if (proxyRun.exitCode !== 0) process.exit(proxyRun.exitCode)
  testCount = extractTestCount(proxyRun.stdout) ?? extractTestCount(proxyRun.stderr)
}

const lcovPath = `${COV_DIR}/lcov.info`
const lcovFile = Bun.file(lcovPath)

if (!(await lcovFile.exists())) {
  console.error("\n❌ lcov.info not generated — cannot check coverage")
  process.exit(1)
}

const report = parseLcov(await lcovFile.text())

if (explicitThreshold !== null && !Number.isNaN(explicitThreshold)) {
  console.log(`\n📊 Proxy coverage: ${report.total.pct.toFixed(1)}% lines (legacy threshold: ${explicitThreshold}%)`)
  if (report.total.pct < explicitThreshold) {
    console.error(`❌ Line coverage ${report.total.pct.toFixed(1)}% is below threshold ${explicitThreshold}%`)
    process.exit(1)
  }
  console.log("✅ Coverage threshold passed")
  process.exit(0)
}

const baselineFile = Bun.file(BASELINE_PATH)
if (!(await baselineFile.exists())) {
  console.error(`❌ baseline file missing: ${BASELINE_PATH}`)
  process.exit(1)
}
const baseline = loadBaseline(await baselineFile.text())

console.log(
  `\n📊 Proxy coverage: ${report.total.pct.toFixed(2)}% lines ` +
    `(floor ${baseline.enforcement.globalFloorPct.toFixed(2)}%, mode=${baseline.enforcement.mode})`,
)
if (testCount !== null) {
  const base = baseline.proxy.l1TestCount
  const suffix = base !== null ? ` (baseline ${base})` : ""
  console.log(`   L1 tests: ${testCount}${suffix}`)
}
for (const [dir, agg] of Object.entries(report.byDirectory)) {
  console.log(`   - ${dir}/: ${agg.pct.toFixed(2)}%`)
}

const violations = evaluateGate(report, baseline, {
  testCount,
  sourceFiles: await listProxySourceFiles(),
})
if (violations.length > 0) {
  console.error("\n❌ Coverage gate failed:")
  for (const v of violations) console.error(`   [${v.kind}] ${v.detail}`)
  process.exit(1)
}
console.log("\n✅ Coverage gate passed")
