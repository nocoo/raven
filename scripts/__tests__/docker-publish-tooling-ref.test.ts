import { describe, expect, test } from "vitest"
import { resolveDockerPublishToolingRef } from "../lib/docker-publish-tooling-ref.ts"

const WORKFLOW_SHA = "abc123def4567890abcdef1234567890abcdef12"

describe("resolveDockerPublishToolingRef", () => {
  test("treats unknown events like release and pins workflow sha", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "schedule",
        workflowDispatchSha: "",
        releaseWorkflowSha: WORKFLOW_SHA,
      }),
    ).toBe(WORKFLOW_SHA)
  })

  test("defaults missing string inputs to empty", () => {
    expect(() =>
      resolveDockerPublishToolingRef({
        eventName: undefined as unknown as string,
        workflowDispatchSha: undefined as unknown as string,
        releaseWorkflowSha: undefined as unknown as string,
      }),
    ).toThrow(/workflow_sha/)
  })

  test("trims workflow sha on release events", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "release",
        workflowDispatchSha: "   ",
        releaseWorkflowSha: `  ${WORKFLOW_SHA.toUpperCase()}  `,
      }),
    ).toBe(WORKFLOW_SHA)
  })

  test("uses dispatch branch head for workflow_dispatch", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "workflow_dispatch",
        workflowDispatchSha: WORKFLOW_SHA,
        releaseWorkflowSha: "f".repeat(40),
      }),
    ).toBe(WORKFLOW_SHA)
  })

  test("rejects missing dispatch sha", () => {
    expect(() =>
      resolveDockerPublishToolingRef({
        eventName: "workflow_dispatch",
        workflowDispatchSha: "",
        releaseWorkflowSha: WORKFLOW_SHA,
      }),
    ).toThrow(/github\.sha/)
  })

  test("rejects invalid release workflow sha", () => {
    expect(() =>
      resolveDockerPublishToolingRef({
        eventName: "release",
        workflowDispatchSha: WORKFLOW_SHA,
        releaseWorkflowSha: "",
      }),
    ).toThrow(/workflow_sha/)
  })

  test("pins release tooling when tag commit lags default branch", () => {
    expect(
      resolveDockerPublishToolingRef({
        eventName: "release",
        workflowDispatchSha: "f7858e58d51552f996cf187da75d326ccfe6f39c",
        releaseWorkflowSha: WORKFLOW_SHA,
      }),
    ).toBe(WORKFLOW_SHA)
  })
})
