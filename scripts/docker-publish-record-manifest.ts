#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs"
import {
  type GhcrReleaseManifest,
  GHCR_IMAGE,
  renderGhcrJobSummary,
} from "./lib/docker-publish-build.ts"

const manifest: GhcrReleaseManifest = {
  image: GHCR_IMAGE,
  tag: String(process.env.RELEASE_TAG ?? ""),
  version: String(process.env.RELEASE_VERSION ?? ""),
  digest: String(process.env.RELEASE_DIGEST ?? ""),
  sourceSha: String(process.env.RELEASE_SOURCE_SHA ?? ""),
  sourceRunId: String(process.env.RELEASE_SOURCE_RUN_ID ?? ""),
  prerelease: process.env.RELEASE_PRERELEASE === "true",
  platform: "linux/amd64",
}

if (!manifest.digest.startsWith("sha256:")) {
  console.error("RELEASE_DIGEST must start with sha256:")
  process.exit(1)
}

mkdirSync("ghcr-release", { recursive: true })
writeFileSync("ghcr-release/manifest.json", JSON.stringify(manifest, null, 2))
const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  writeFileSync(summaryPath, `${renderGhcrJobSummary(manifest)}\n`)
}
