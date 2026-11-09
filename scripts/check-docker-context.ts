#!/usr/bin/env bun
/** Fails when .dockerignore drops any tracked Dockerfile build input. */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import {
  auditBuildContext,
  checkRequiredAppEntries,
  expectedAppPaths,
  formatContextAudit,
} from "./lib/docker-context.ts"

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "")
const audit = auditBuildContext({
  files,
  dockerignore: readFileSync(".dockerignore", "utf8"),
  dockerfile: readFileSync("Dockerfile", "utf8"),
})
const problems = [...formatContextAudit(audit), ...checkRequiredAppEntries(files)]

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}
console.log(
  `✓ Docker build context keeps all inputs of ${audit.sources.length} COPY sources (${expectedAppPaths(files).size} dashboard app entries)`,
)
