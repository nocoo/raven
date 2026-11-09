import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { buildGhcrTagList } from "../lib/docker-publish-build.ts"
import {
  DOCKER_PUBLISH_ACTION_PINS,
  DOCKER_PUBLISH_BUN_VERSION,
  DOCKER_PUBLISH_RELEASE_CHECKOUT_PATH,
} from "../lib/docker-publish-workflow-contract.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workflowPath = resolve(root, ".github/workflows/docker-publish.yml")

describe("docker publish workflow contract", () => {
  test("keeps tooling and release checkouts separate for historical backfill", () => {
    const workflow = readFileSync(workflowPath, "utf8")
    const toolingCheckouts =
      workflow.match(/^\s+path: \.ci-tooling\s*$/gm) ?? []
    const releaseCheckouts =
      workflow.match(/^\s+path: release\s*$/gm) ?? []
    expect(toolingCheckouts).toHaveLength(2)
    expect(releaseCheckouts).toHaveLength(1)
    expect(workflow).toContain("workflow_dispatch' && github.sha")
    expect(workflow).toContain("refs/heads/{0}', github.event.repository.default_branch")
    expect(workflow).toMatch(
      new RegExp(
        `ref: \\$\\{\\{ needs\\.source\\.outputs\\.target-sha \\}\\}[\\s\\S]*path: ${DOCKER_PUBLISH_RELEASE_CHECKOUT_PATH}`,
      ),
    )
    expect(workflow).toContain(`context: ${DOCKER_PUBLISH_RELEASE_CHECKOUT_PATH}`)
    expect(workflow).toContain(
      `file: ${DOCKER_PUBLISH_RELEASE_CHECKOUT_PATH}/Dockerfile`,
    )
    expect(workflow).not.toMatch(
      /context:\s*\.\s*\n[\s\S]*ref:\s*\$\{\{\s*needs\.source\.outputs\.target-sha/,
    )
  })

  test("installs pinned Bun before workflow scripts in both jobs", () => {
    const workflow = readFileSync(workflowPath, "utf8")
    const setupBun =
      workflow.match(
        /oven-sh\/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6/g,
      ) ?? []
    expect(setupBun).toHaveLength(2)
    expect(workflow).toContain(`bun-version: ${DOCKER_PUBLISH_BUN_VERSION}`)
    expect(workflow).toContain("working-directory: .ci-tooling")
    expect(workflow).toContain("working-directory: release")
    expect(workflow).toContain(
      "bun run ../.ci-tooling/scripts/docker-publish-verify-checkout.ts",
    )
  })

  test("pins third-party actions to documented immutable refs", () => {
    const workflow = readFileSync(workflowPath, "utf8")
    for (const pin of DOCKER_PUBLISH_ACTION_PINS) {
      expect(workflow).toContain(pin)
    }
    expect(workflow).toContain('package-version-match: "true"')
    expect(workflow).toContain("docker-publish-validate.ts")
    expect(workflow).toContain("docker-publish-wait-ci.ts")
    expect(workflow).toMatch(/^\s+permissions:\s*$/m)
    expect(workflow).toContain("packages: write")
    expect(workflow).not.toMatch(/:latest\b/)
    expect(workflow).not.toContain("VPS_HOST")
  })

  test("models v3.3.2 backfill: tooling at trigger sha, image from proven tag commit", () => {
    const legacyReleaseSha = "f7858e58d51552f996cf187da75d326ccfe6f39c"
    const workflow = readFileSync(workflowPath, "utf8")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("github.sha")
    expect(workflow).toContain("target-sha")
    expect(
      buildGhcrTagList({
        sourceSha: legacyReleaseSha,
        version: "3.3.2",
        prerelease: false,
      }),
    ).toEqual([
      `ghcr.io/nocoo/raven:${legacyReleaseSha}`,
      "ghcr.io/nocoo/raven:v3.3.2",
      "ghcr.io/nocoo/raven:3.3.2",
    ])
  })
})
