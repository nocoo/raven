import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workflowPath = resolve(root, ".github/workflows/docker-publish.yml")

const ACTION_PINS: Array<{ repo: string; sha: string; fragment: string }> = [
  {
    repo: "actions/checkout",
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    fragment: "actions/checkout@",
  },
  {
    repo: "docker/setup-buildx-action",
    sha: "37fe631027851001ddb9b187196cc803df7f5f0e",
    fragment: "docker/setup-buildx-action@",
  },
  {
    repo: "docker/login-action",
    sha: "dbcb813823bdd20940b903addbd779551569679f",
    fragment: "docker/login-action@",
  },
  {
    repo: "docker/build-push-action",
    sha: "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
    fragment: "docker/build-push-action@",
  },
  {
    repo: "actions/upload-artifact",
    sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    fragment: "actions/upload-artifact@",
  },
  {
    repo: "nocoo/base-ci",
    sha: "2231caf82cf16f103f48cab467b3464b106d6604",
    fragment: "nocoo/base-ci/.github/actions/release-source@",
  },
]

describe("docker publish workflow contract", () => {
  test("passes actionlint and YAML parsing", () => {
    execFileSync("actionlint", [workflowPath], { stdio: "pipe" })
    execFileSync(
      "python3",
      [
        "-c",
        "import yaml,sys; yaml.safe_load(open(sys.argv[1])); print('yaml.safe_load: ok')",
        workflowPath,
      ],
      { encoding: "utf8" },
    )
  })

  test("checks out proven target-sha and verifies HEAD", () => {
    const workflow = readFileSync(workflowPath, "utf8")
    expect(workflow).toMatch(
      /ref: \$\{\{ needs\.source\.outputs\.target-sha \}\}/,
    )
    expect(workflow).not.toMatch(/refs\/tags\/\$\{\{/)
    expect(workflow).toContain("docker-publish-verify-checkout.ts")
  })

  test("pins third-party actions to expected repositories", async () => {
    for (const pin of ACTION_PINS) {
      const response = await fetch(
        `https://api.github.com/repos/${pin.repo}/commits/${pin.sha}`,
      )
      expect(response.ok, `${pin.repo} ${pin.sha}`).toBe(true)
    }
    const workflow = readFileSync(workflowPath, "utf8")
    for (const pin of ACTION_PINS) {
      expect(workflow).toContain(`${pin.fragment}${pin.sha}`)
    }
  })

  test("wires release-source inputs required for tag proof", () => {
    const workflow = readFileSync(workflowPath, "utf8")
    expect(workflow).toContain("expected-workflow-path: .github/workflows/ci.yml")
    expect(workflow).toContain("expected-workflow-name: CI")
    expect(workflow).toContain("package-version-match: \"true\"")
    expect(workflow).toContain("require-fresh-main: \"false\"")
    expect(workflow).toContain("docker-publish-validate.ts")
  })
})
