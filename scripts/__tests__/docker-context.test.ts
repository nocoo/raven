import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import {
  auditBuildContext,
  checkRequiredAppEntries,
  formatContextAudit,
} from "../lib/docker-context.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("repository docker build context", () => {
  test("keeps every tracked Dockerfile input, including app test routes", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((file) => file !== "")
    const audit = auditBuildContext({
      files,
      dockerignore: read(".dockerignore"),
      dockerfile: read("Dockerfile"),
    })
    expect(formatContextAudit(audit)).toEqual([])
    expect(checkRequiredAppEntries(files)).toEqual([])
    expect(read(".dockerignore")).not.toMatch(/^\*\*\/(test|tests|e2e)\/?$/m)
  })

  test("publish workflow checks context before build and image routes before push", () => {
    const workflow = read(".github/workflows/docker-publish.yml")
    const contextCheck = workflow.indexOf("check-docker-context.ts")
    const verifyBuild = workflow.indexOf("load: true")
    const routeCheck = workflow.indexOf("docker-publish-verify-image-routes.ts")
    const push = workflow.indexOf("push: true")
    expect(contextCheck).toBeGreaterThan(-1)
    expect(verifyBuild).toBeGreaterThan(contextCheck)
    expect(routeCheck).toBeGreaterThan(verifyBuild)
    expect(push).toBeGreaterThan(routeCheck)
    expect(read(".github/workflows/ci.yml")).toContain("bun run gate:docker-context")
  })
})
