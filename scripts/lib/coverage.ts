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
    totalFound += f.linesFound
    totalHit += f.linesHit
    const dir = topLevelDir(f.path)
    if (dir !== null) {
      const slot = dirAgg[dir] ?? { linesFound: 0, linesHit: 0 }
      slot.linesFound += f.linesFound
      slot.linesHit += f.linesHit
      dirAgg[dir] = slot
    }
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
  kind: "global-regression" | "directory-regression" | "below-floor"
  detail: string
}

export function evaluateGate(
  report: CoverageReport,
  baseline: Baseline,
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
