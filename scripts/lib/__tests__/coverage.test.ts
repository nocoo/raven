import { describe, expect, test } from "bun:test"
import { parseLcov, evaluateGate, loadBaseline, type Baseline } from "../coverage"

const SAMPLE_LCOV = `TN:
SF:src/routes/messages/handler.ts
FNF:3
FNH:3
DA:1,10
DA:2,5
DA:3,0
LF:3
LH:2
end_of_record
TN:
SF:src/lib/state.ts
FNF:1
FNH:1
DA:1,1
LF:1
LH:1
end_of_record
TN:
SF:src/util/id.ts
FNF:1
FNH:1
DA:1,1
DA:2,1
DA:3,0
DA:4,1
LF:4
LH:3
end_of_record
`

function baseline(overrides: Partial<Baseline["enforcement"]> = {}, proxyOverrides: Partial<Baseline["proxy"]> = {}): Baseline {
  return {
    capturedAt: null,
    proxy: {
      l1TestCount: null,
      statementCoveragePct: null,
      perDirectoryCoveragePct: {},
      ...proxyOverrides,
    },
    dashboard: { l1TestCount: null },
    enforcement: {
      mode: "placeholder",
      globalFloorPct: 50,
      regressionAllowanceAbsPct: 0.1,
      perDirectoryFloors: {},
      ...overrides,
    },
  }
}

describe("parseLcov", () => {
  test("aggregates total lines found and hit", () => {
    const r = parseLcov(SAMPLE_LCOV)
    expect(r.total.linesFound).toBe(8)
    expect(r.total.linesHit).toBe(6)
    expect(r.total.pct).toBeCloseTo(75, 5)
  })

  test("tracks per-file entries", () => {
    const r = parseLcov(SAMPLE_LCOV)
    expect(r.byFile.length).toBe(3)
    expect(r.byFile[0]?.path).toBe("src/routes/messages/handler.ts")
    expect(r.byFile[0]?.linesHit).toBe(2)
  })

  test("groups by top-level src directory", () => {
    const r = parseLcov(SAMPLE_LCOV)
    expect(Object.keys(r.byDirectory).sort()).toEqual(["lib", "routes", "util"])
    expect(r.byDirectory.routes?.linesFound).toBe(3)
    expect(r.byDirectory.routes?.pct).toBeCloseTo(66.666, 2)
  })

  test("handles empty input", () => {
    const r = parseLcov("")
    expect(r.total.linesFound).toBe(0)
    expect(r.total.pct).toBe(0)
    expect(r.byFile).toEqual([])
  })

  test("skips files outside src/", () => {
    const r = parseLcov("SF:test/foo.ts\nLF:1\nLH:1\nend_of_record\n")
    expect(r.byFile.length).toBe(1)
    expect(Object.keys(r.byDirectory)).toEqual([])
  })
})

describe("evaluateGate", () => {
  const report = parseLcov(SAMPLE_LCOV)

  test("passes when above floor in placeholder mode", () => {
    expect(evaluateGate(report, baseline({ globalFloorPct: 50 }))).toEqual([])
  })

  test("flags below-floor violation", () => {
    const v = evaluateGate(report, baseline({ globalFloorPct: 90 }))
    expect(v).toHaveLength(1)
    expect(v[0]?.kind).toBe("below-floor")
  })

  test("does not check regression in placeholder mode", () => {
    const v = evaluateGate(report, baseline({ mode: "placeholder", globalFloorPct: 10 }, { statementCoveragePct: 99 }))
    expect(v).toEqual([])
  })

  test("flags global regression in enforce mode", () => {
    const v = evaluateGate(
      report,
      baseline({ mode: "enforce", globalFloorPct: 10, regressionAllowanceAbsPct: 0.1 }, { statementCoveragePct: 95 }),
    )
    expect(v).toHaveLength(1)
    expect(v[0]?.kind).toBe("global-regression")
  })

  test("does not flag global regression within allowance", () => {
    const v = evaluateGate(
      report,
      baseline(
        { mode: "enforce", globalFloorPct: 10, regressionAllowanceAbsPct: 0.5 },
        { statementCoveragePct: 75.4 },
      ),
    )
    expect(v).toEqual([])
  })

  test("flags per-directory floor breach", () => {
    const v = evaluateGate(
      report,
      baseline({ perDirectoryFloors: { routes: 100 } }),
    )
    expect(v).toHaveLength(1)
    expect(v[0]?.detail).toContain("routes/")
  })

  test("flags per-directory regression in enforce mode", () => {
    const v = evaluateGate(
      report,
      baseline(
        { mode: "enforce", globalFloorPct: 10 },
        { statementCoveragePct: 75, perDirectoryCoveragePct: { routes: 100 } },
      ),
    )
    expect(v.some((x) => x.kind === "directory-regression")).toBe(true)
  })

  test("skips per-directory regression when directory was migrated away", () => {
    // services/ exists in baseline but not in the current report —
    // Phase E relocates whole directories. This must not count as
    // regressing from (e.g.) 98% to 0%.
    const v = evaluateGate(
      report,
      baseline(
        { mode: "enforce", globalFloorPct: 10 },
        {
          statementCoveragePct: 75,
          perDirectoryCoveragePct: { services: 98 },
        },
      ),
    )
    expect(v.some((x) => x.kind === "directory-regression")).toBe(false)
  })

  test("skips per-directory floor breach when directory was migrated away", () => {
    // A floor authored against a directory that no longer exists must
    // not falsely fire. Removing the dir from the baseline is the
    // reviewer's job; the gate should not block the commit that does
    // the move.
    const v = evaluateGate(
      report,
      baseline({ globalFloorPct: 10, perDirectoryFloors: { services: 95 } }),
    )
    expect(v.some((x) => x.detail.includes("services/"))).toBe(false)
  })
})

describe("loadBaseline", () => {
  test("parses a well-formed baseline", () => {
    const b = loadBaseline(
      JSON.stringify(baseline()),
    )
    expect(b.enforcement.mode).toBe("placeholder")
  })

  test("rejects missing enforcement section", () => {
    expect(() => loadBaseline(JSON.stringify({ proxy: {}, dashboard: {} }))).toThrow("enforcement")
  })

  test("rejects missing proxy section", () => {
    expect(() =>
      loadBaseline(
        JSON.stringify({
          enforcement: { mode: "placeholder", globalFloorPct: 95, regressionAllowanceAbsPct: 0.1, perDirectoryFloors: {} },
          dashboard: { l1TestCount: null },
        }),
      ),
    ).toThrow("proxy")
  })

  test("rejects unknown mode", () => {
    expect(() =>
      loadBaseline(
        JSON.stringify({
          proxy: { l1TestCount: null, statementCoveragePct: null, perDirectoryCoveragePct: {} },
          dashboard: { l1TestCount: null },
          enforcement: { mode: "yolo", globalFloorPct: 90, regressionAllowanceAbsPct: 0.1, perDirectoryFloors: {} },
        }),
      ),
    ).toThrow("mode")
  })

  test("rejects non-numeric floor", () => {
    expect(() =>
      loadBaseline(
        JSON.stringify({
          proxy: { l1TestCount: null, statementCoveragePct: null, perDirectoryCoveragePct: {} },
          dashboard: { l1TestCount: null },
          enforcement: { mode: "placeholder", globalFloorPct: "oops", regressionAllowanceAbsPct: 0.1, perDirectoryFloors: {} },
        }),
      ),
    ).toThrow("globalFloorPct")
  })

  test("rejects non-numeric allowance", () => {
    expect(() =>
      loadBaseline(
        JSON.stringify({
          proxy: { l1TestCount: null, statementCoveragePct: null, perDirectoryCoveragePct: {} },
          dashboard: { l1TestCount: null },
          enforcement: { mode: "placeholder", globalFloorPct: 95, regressionAllowanceAbsPct: "oops", perDirectoryFloors: {} },
        }),
      ),
    ).toThrow("regressionAllowanceAbsPct")
  })
})
