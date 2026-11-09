import { describe, expect, test } from "vitest"
import { resolveDockerPublishToolingRef } from "../lib/docker-publish-tooling-ref.ts"

describe("resolveDockerPublishToolingRef", () => {
  test("treats unknown events like release and uses default branch", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "schedule",
        workflowDispatchSha: "",
        defaultBranch: "main",
      }),
    ).toBe("refs/heads/main")
  })

  test("defaults missing string inputs to empty", () => {
    expect(() =>
      resolveDockerPublishToolingRef({
        eventName: undefined as unknown as string,
        workflowDispatchSha: undefined as unknown as string,
        defaultBranch: undefined as unknown as string,
      }),
    ).toThrow(/default_branch/)
  })

  test("trims missing option values on release events", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "release",
        workflowDispatchSha: "   ",
        defaultBranch: "main",
      }),
    ).toBe("refs/heads/main")
  })

  test("uses dispatch branch head for workflow_dispatch", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "workflow_dispatch",
        workflowDispatchSha: "abc123def4567890abcdef1234567890abcdef12",
        defaultBranch: "main",
      }),
    ).toBe("abc123def4567890abcdef1234567890abcdef12")
  })

  test("rejects missing dispatch sha", () => {
    expect(() =>
      resolveDockerPublishToolingRef({
        eventName: "workflow_dispatch",
        workflowDispatchSha: "",
        defaultBranch: "main",
      }),
    ).toThrow(/github\.sha/)
  })

  test("rejects missing default branch on release", () => {
    expect(() =>
      resolveDockerPublishToolingRef({
        eventName: "release",
        workflowDispatchSha: "a".repeat(40),
        defaultBranch: "",
      }),
    ).toThrow(/default_branch/)
  })

  test("uses default branch head when release lags tag commit", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "release",
        workflowDispatchSha: "f7858e58d51552f996cf187da75d326ccfe6f39c",
        defaultBranch: "main",
      }),
    ).toBe("refs/heads/main")
  })
})
