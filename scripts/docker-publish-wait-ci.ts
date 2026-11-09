#!/usr/bin/env bun
import { waitForTrustedCiSuccess } from "./lib/docker-publish-wait-ci.ts"

try {
  const result = await waitForTrustedCiSuccess({
    repository: String(process.env.GITHUB_REPOSITORY ?? ""),
    apiUrl: String(process.env.GITHUB_API_URL ?? "https://api.github.com"),
    token: String(process.env.GITHUB_TOKEN ?? ""),
    tag: String(process.env.RELEASE_TAG ?? ""),
    expectedWorkflowPath: ".github/workflows/ci.yml",
    expectedWorkflowName: "CI",
    expectedBranch: "main",
    timeoutMs: Number(process.env.CI_WAIT_TIMEOUT_MS ?? 30 * 60 * 1000),
    pollMs: Number(process.env.CI_WAIT_POLL_MS ?? 30 * 1000),
  })
  console.log(
    `CI ready for ${result.targetSha} (run ${result.runId}) before release-source`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : "CI wait failed")
  process.exit(1)
}
