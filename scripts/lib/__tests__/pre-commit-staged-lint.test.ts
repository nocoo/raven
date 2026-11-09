import { describe, expect, test } from "vitest"

import { lintStagedPatterns, pathsMatchingLintStaged } from "../pre-commit-staged-lint"

describe("pre-commit staged lint", () => {
  test("patterns match root lint-staged keys", () => {
    const patterns = lintStagedPatterns()
    expect(patterns.length).toBeGreaterThan(0)
    expect(patterns.some((p) => p.includes("packages/"))).toBe(true)
    expect(patterns.some((p) => p.startsWith("scripts/"))).toBe(true)
  })

  test("filters staged paths to lint-staged scope", () => {
    const patterns = lintStagedPatterns()
    const hits = pathsMatchingLintStaged(
    [
      "packages/proxy/src/app.ts",
      "packages/dashboard/src/foo.tsx",
      "scripts/pre-commit.ts",
      "README.md",
      "packages/proxy/dist/bundle.js",
    ],
    patterns,
  )
    expect(hits).toEqual([
      "packages/proxy/src/app.ts",
      "packages/dashboard/src/foo.tsx",
      "scripts/pre-commit.ts",
    ])
  })
})
