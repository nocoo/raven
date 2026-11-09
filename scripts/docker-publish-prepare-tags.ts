#!/usr/bin/env bun
import { buildGhcrTagList } from "./lib/docker-publish-build.ts"
import { writeGitHubStepOutput } from "./lib/docker-publish-release.ts"

const output = process.env.GITHUB_OUTPUT
if (!output) {
  console.error("GITHUB_OUTPUT is missing")
  process.exit(1)
}

try {
  const tags = buildGhcrTagList({
    sourceSha: String(process.env.RELEASE_SOURCE_SHA ?? ""),
    version: String(process.env.RELEASE_VERSION ?? ""),
    prerelease: process.env.RELEASE_PRERELEASE === "true",
  })
  writeGitHubStepOutput(output, { list: tags.join(",") })
} catch (error) {
  console.error(error instanceof Error ? error.message : "Tag preparation failed")
  process.exit(1)
}
