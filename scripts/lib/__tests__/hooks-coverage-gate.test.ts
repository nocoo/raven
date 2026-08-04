import { describe, expect, test } from "vitest"

import { tasks as preCommitTasks } from "../../pre-commit"
import { tasks as prePushTasks } from "../../pre-push"

/**
 * Regression: v2.5.0 release push passed local pre-push while CI failed
 * check-coverage.ts (baseline floors / untested files). Root cause: pre-push
 * ran bare `proxy test` (vitest thresholds only) instead of the CI baseline gate.
 */
describe("hook L1 coverage wiring", () => {
  test("pre-push coverage task invokes gate:coverage (check-coverage.ts)", () => {
    const coverage = prePushTasks.find((t) => t.name === "coverage")
    expect(coverage).toBeDefined()
    expect(coverage!.gate).toBe("L1")
    expect(coverage!.cmd.join(" ")).toContain("gate:coverage")
    expect(coverage!.cmd.join(" ")).not.toMatch(/--filter.*@raven\/proxy.*test/)
  })

  test("pre-commit coverage task invokes gate:coverage (check-coverage.ts)", () => {
    const coverage = preCommitTasks.find((t) => t.name === "coverage")
    expect(coverage).toBeDefined()
    expect(coverage!.gate).toBe("L1")
    expect(coverage!.cmd.join(" ")).toContain("gate:coverage")
  })

  test("pre-commit still runs dashboard unit tests separately", () => {
    const dash = preCommitTasks.find((t) => t.name === "dashboard-tests")
    expect(dash).toBeDefined()
    expect(dash!.cmd.join(" ")).toMatch(/dashboard/)
  })

  test("pre-commit runs scripts unit tests (vitest --project scripts only)", () => {
    const scripts = preCommitTasks.find((t) => t.name === "scripts-tests")
    expect(scripts).toBeDefined()
    const joined = scripts!.cmd.join(" ")
    expect(joined).toContain("vitest")
    expect(joined).toContain("--project")
    expect(joined).toContain("scripts")
  })
})
