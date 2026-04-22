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

const args = new Set(process.argv.slice(2))
const thresholdArg = [...args].find((a) => a.startsWith("--threshold="))
const explicitThreshold = thresholdArg ? Number(thresholdArg.slice("--threshold=".length)) : null
const skipTests = args.has("--skip-tests")
const BASELINE_PATH = `${import.meta.dir}/../docs/20-baseline.json`
const COV_DIR = `${import.meta.dir}/../packages/proxy/coverage`

let testCount: number | null = null

/**
 * Parse bun's "Ran N tests across M files." summary line.
 * Returns null if the line isn't present (e.g. skipped-tests mode).
 */
function extractTestCount(output: string): number | null {
  const match = output.match(/Ran (\d+) tests? across \d+ files?\./)
  return match ? Number(match[1]) : null
}

if (!skipTests) {
  const libTests = Bun.spawn(["bun", "test", "scripts/lib"], {
    cwd: `${import.meta.dir}/..`,
    stdout: "inherit",
    stderr: "inherit",
  })
  const libExit = await libTests.exited
  if (libExit !== 0) process.exit(libExit)

  const proc = Bun.spawn(
    [
      "bun",
      "test",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${COV_DIR}`,
      "test/db",
      "test/lib",
      "test/routes",
      "test/services",
      "test/translate",
      "test/util",
      "test/ws",
      "test/middleware.test.ts",
      "test/app.test.ts",
      "test/config.test.ts",
    ],
    {
      cwd: `${import.meta.dir}/../packages/proxy`,
      stdout: "inherit",
      stderr: "pipe",
    },
  )

  // bun test prints the final "Ran N tests…" summary on stderr. Tee
  // it to the real stderr (preserving live output) and capture so we
  // can read the test count for the §4.5 regression check.
  let stderrBuf = ""
  const stderrReader = proc.stderr.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    while (true) {
      const { value, done } = await stderrReader.read()
      if (done) break
      const chunk = decoder.decode(value)
      stderrBuf += chunk
      process.stderr.write(chunk)
    }
  })()

  const exitCode = await proc.exited
  if (exitCode !== 0) process.exit(exitCode)
  testCount = extractTestCount(stderrBuf)
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

const violations = evaluateGate(report, baseline, { testCount })
if (violations.length > 0) {
  console.error("\n❌ Coverage gate failed:")
  for (const v of violations) console.error(`   [${v.kind}] ${v.detail}`)
  process.exit(1)
}
console.log("\n✅ Coverage gate passed")
