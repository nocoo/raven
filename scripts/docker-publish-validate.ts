#!/usr/bin/env bun
import {
  resolveReleaseMetadata,
  writeGitHubStepOutput,
} from "./lib/docker-publish-release.ts"

const output = process.env.GITHUB_OUTPUT
if (!output) {
  console.error("GITHUB_OUTPUT is missing")
  process.exit(1)
}

try {
  const meta = await resolveReleaseMetadata({
    eventName: String(process.env.EVENT_NAME ?? ""),
    rawTag: String(process.env.RELEASE_TAG ?? ""),
    releasePrereleaseFlag: process.env.RELEASE_PRERELEASE,
    repository: String(process.env.GITHUB_REPOSITORY ?? ""),
    apiUrl: String(process.env.GITHUB_API_URL ?? "https://api.github.com"),
    token: String(process.env.GITHUB_TOKEN ?? ""),
  })
  writeGitHubStepOutput(output, {
    "release-tag": meta.tag,
    "release-version": meta.version,
    prerelease: meta.prerelease ? "true" : "false",
  })
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Release validation failed",
  )
  process.exit(1)
}
