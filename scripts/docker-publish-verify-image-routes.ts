#!/usr/bin/env bun
/** Asserts the built image's Next app-paths-manifest covers every source app entry. */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { missingAppPaths } from "./lib/docker-context.ts"

const manifestPath = process.argv[2]
if (!manifestPath) {
  console.error("Usage: docker-publish-verify-image-routes.ts <app-paths-manifest.json>")
  process.exit(1)
}
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
const missing = missingAppPaths(files, manifest)
if (missing.length > 0) {
  for (const key of missing) console.error(`✗ Image app-paths-manifest is missing ${key}`)
  process.exit(1)
}
console.log(`✓ Image app-paths-manifest covers every source app entry (${Object.keys(manifest).length} manifest keys)`)
