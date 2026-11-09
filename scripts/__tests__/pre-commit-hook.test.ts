import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, test } from "vitest"

const hookPath = resolve(import.meta.dirname, "../../.husky/pre-commit")

describe("pre-commit husky launcher", () => {
  test("exports the Git index via checkout-index and cleans up on exit", () => {
    const script = readFileSync(hookPath, "utf8")
    expect(script).toContain("git checkout-index --all")
    expect(script).toContain('trap cleanup EXIT')
    expect(script).toContain("mktemp -d")
    expect(script).toContain("raven-index-")
    expect(script).toContain("gitleaks protect --staged")
    expect(script).toContain("RAVEN_HOOK_INDEX=1")
    expect(script).toContain('export GIT_WORK_TREE="$snapshot"')
  })
})
