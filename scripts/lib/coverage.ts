export interface FileCoverage {
  path: string
  linesFound: number
  linesHit: number
}

export interface CoverageReport {
  total: { linesFound: number; linesHit: number; pct: number }
  byFile: FileCoverage[]
  byDirectory: Record<string, { linesFound: number; linesHit: number; pct: number }>
}

export interface BaselineFloors {
  global: number
  perDirectory: Record<string, number>
}

export interface Baseline {
  $schema?: string
  capturedAt: string | null
  proxy: {
    l1TestCount: number | null
    statementCoveragePct: number | null
    perDirectoryCoveragePct: Record<string, number | null>
  }
  dashboard: {
    l1TestCount: number | null
  }
  enforcement: {
    mode: "placeholder" | "enforce"
    globalFloorPct: number
    regressionAllowanceAbsPct: number
    perDirectoryFloors: Record<string, number>
    /**
     * Legacy src/ files that have been triaged as intentionally
     * uncovered (entry points, migration shims, etc.). Listed here to
     * keep the "new file without test" gate strict for future
     * additions without forcing retroactive tests for existing code.
     */
    allowUntestedFiles?: string[]
  }
}

export function parseLcov(lcov: string): CoverageReport {
  const byFile: FileCoverage[] = []
  let currentPath: string | null = null
  let currentFound = 0
  let currentHit = 0

  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      currentPath = line.slice(3).trim()
      currentFound = 0
      currentHit = 0
    } else if (line.startsWith("LF:")) {
      currentFound = parseInt(line.slice(3), 10) || 0
    } else if (line.startsWith("LH:")) {
      currentHit = parseInt(line.slice(3), 10) || 0
    } else if (line === "end_of_record" && currentPath !== null) {
      byFile.push({ path: currentPath, linesFound: currentFound, linesHit: currentHit })
      currentPath = null
    }
  }

  let totalFound = 0
  let totalHit = 0
  const dirAgg: Record<string, { linesFound: number; linesHit: number }> = {}
  for (const f of byFile) {
    const dir = topLevelDir(f.path)
    // Only src/ files count toward the global and per-directory totals.
    // Test helpers (test/e2e/*, test-only fixtures) can be imported by L1
    // specs and would otherwise skew the gate with non-production code.
    if (dir === null) continue
    totalFound += f.linesFound
    totalHit += f.linesHit
    const slot = dirAgg[dir] ?? { linesFound: 0, linesHit: 0 }
    slot.linesFound += f.linesFound
    slot.linesHit += f.linesHit
    dirAgg[dir] = slot
  }

  const byDirectory: Record<string, { linesFound: number; linesHit: number; pct: number }> = {}
  for (const [dir, agg] of Object.entries(dirAgg)) {
    byDirectory[dir] = {
      ...agg,
      pct: agg.linesFound > 0 ? (agg.linesHit / agg.linesFound) * 100 : 0,
    }
  }

  return {
    total: {
      linesFound: totalFound,
      linesHit: totalHit,
      pct: totalFound > 0 ? (totalHit / totalFound) * 100 : 0,
    },
    byFile,
    byDirectory,
  }
}

function topLevelDir(srcPath: string): string | null {
  if (!srcPath.startsWith("src/")) return null
  const stripped = srcPath.slice("src/".length)
  const idx = stripped.indexOf("/")
  if (idx === -1) return null
  return stripped.slice(0, idx)
}

export interface GateViolation {
  kind:
    | "global-regression"
    | "directory-regression"
    | "below-floor"
    | "test-count-regression"
    | "file-without-coverage"
  detail: string
}

export interface GateInputs {
  /** Actual L1 test count observed this run. null = not measured. */
  testCount?: number | null
  /**
   * Full list of source files that *should* appear in the coverage
   * report (typically every `src/**\/*.ts` under the package). Any
   * entry missing from `report.byFile` is flagged as a new file
   * landing without any test that imports it — bun's lcov only
   * records files actually loaded during the test run, so a file
   * that no test touches is silently absent otherwise.
   */
  sourceFiles?: string[]
}

export function evaluateGate(
  report: CoverageReport,
  baseline: Baseline,
  inputs: GateInputs = {},
): GateViolation[] {
  const violations: GateViolation[] = []

  if (report.total.pct + 0.0001 < baseline.enforcement.globalFloorPct) {
    violations.push({
      kind: "below-floor",
      detail: `global ${report.total.pct.toFixed(2)}% < floor ${baseline.enforcement.globalFloorPct.toFixed(2)}%`,
    })
  }

  if (baseline.enforcement.mode === "enforce" && baseline.proxy.statementCoveragePct !== null) {
    const allowance = baseline.enforcement.regressionAllowanceAbsPct
    const regression = baseline.proxy.statementCoveragePct - report.total.pct
    if (regression > allowance + 0.0001) {
      violations.push({
        kind: "global-regression",
        detail: `global ${report.total.pct.toFixed(2)}% regressed by ${regression.toFixed(2)}pp (allowance ${allowance.toFixed(2)}pp) from baseline ${baseline.proxy.statementCoveragePct.toFixed(2)}%`,
      })
    }
  }

  for (const [dir, floor] of Object.entries(baseline.enforcement.perDirectoryFloors)) {
    const entry = report.byDirectory[dir]
    if (entry === undefined) continue // directory migrated/removed — not a floor breach
    if (entry.pct + 0.0001 < floor) {
      violations.push({
        kind: "below-floor",
        detail: `${dir}/ ${entry.pct.toFixed(2)}% < floor ${floor.toFixed(2)}%`,
      })
    }
  }

  if (baseline.enforcement.mode === "enforce") {
    for (const [dir, prev] of Object.entries(baseline.proxy.perDirectoryCoveragePct)) {
      if (prev === null) continue
      const entry = report.byDirectory[dir]
      // Directory absent from the current report means code was moved or
      // deleted; the refactor plan explicitly relocates directories
      // (e.g. services/ in Phase E), so treat missing-dir as a migration
      // and skip the regression check rather than flagging it as a
      // 100%-to-0% drop.
      if (entry === undefined) continue
      const allowance = baseline.enforcement.regressionAllowanceAbsPct
      if (prev - entry.pct > allowance + 0.0001) {
        violations.push({
          kind: "directory-regression",
          detail: `${dir}/ ${entry.pct.toFixed(2)}% regressed by ${(prev - entry.pct).toFixed(2)}pp from baseline ${prev.toFixed(2)}%`,
        })
      }
    }
  }

  // §4.5 test-count regression: the number of L1 tests must not
  // shrink below the recorded baseline (with the same absolute-count
  // allowance as the coverage-pct gate). Skipped when the baseline
  // has no recorded count or the current run did not report one.
  if (
    baseline.enforcement.mode === "enforce" &&
    baseline.proxy.l1TestCount !== null &&
    inputs.testCount !== undefined &&
    inputs.testCount !== null
  ) {
    const drop = baseline.proxy.l1TestCount - inputs.testCount
    if (drop > 0) {
      violations.push({
        kind: "test-count-regression",
        detail: `L1 test count ${inputs.testCount} < baseline ${baseline.proxy.l1TestCount} (dropped ${drop})`,
      })
    }
  }

  // §4.5 "new modules must ship with tests": any src/ file present
  // in the coverage report that never had a line executed (LH=0)
  // means the file exists but no test touches it. Runs in both
  // placeholder and enforce modes so new code can't land untested.
  const reportedPaths = new Set(report.byFile.map((f) => f.path))
  const allowList = new Set(baseline.enforcement.allowUntestedFiles ?? [])
  for (const f of report.byFile) {
    if (!f.path.startsWith("src/")) continue
    if (f.linesFound === 0) continue
    if (allowList.has(f.path)) continue
    if (f.linesHit === 0) {
      violations.push({
        kind: "file-without-coverage",
        detail: `${f.path} has 0 executed lines (${f.linesFound} covered) — add a test`,
      })
    }
  }

  // Secondary check: bun's lcov only records files that were loaded
  // during the run, so a brand-new src/ file with *no* test importing
  // it doesn't show up in report.byFile at all. Caller can pass the
  // authoritative list of src/ files (from disk) so we can flag those
  // too. Skipped when the caller didn't provide sourceFiles.
  if (inputs.sourceFiles) {
    for (const path of inputs.sourceFiles) {
      if (!path.startsWith("src/")) continue
      if (reportedPaths.has(path)) continue
      if (allowList.has(path)) continue
      violations.push({
        kind: "file-without-coverage",
        detail: `${path} is not referenced by any test (absent from lcov) — add a test`,
      })
    }
  }

  return violations
}

export function loadBaseline(raw: string): Baseline {
  const parsed = JSON.parse(raw) as Partial<Baseline>
  if (!parsed.enforcement) {
    throw new Error("baseline.json missing 'enforcement' section")
  }
  if (!parsed.proxy || !parsed.dashboard) {
    throw new Error("baseline.json missing 'proxy' or 'dashboard' section")
  }
  if (parsed.enforcement.mode !== "placeholder" && parsed.enforcement.mode !== "enforce") {
    throw new Error("baseline.enforcement.mode must be 'placeholder' or 'enforce'")
  }
  if (typeof parsed.enforcement.globalFloorPct !== "number") {
    throw new Error("baseline.enforcement.globalFloorPct must be a number")
  }
  if (typeof parsed.enforcement.regressionAllowanceAbsPct !== "number") {
    throw new Error("baseline.enforcement.regressionAllowanceAbsPct must be a number")
  }
  return parsed as Baseline
}
