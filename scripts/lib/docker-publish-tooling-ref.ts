/**
 * Workflow tooling must track the workflow definition that GitHub Actions loaded:
 * - release:published uses the default-branch workflow file while github.sha is the tag commit
 * - workflow_dispatch uses the selected branch head (github.sha)
 */
export function resolveDockerPublishToolingRef(options: {
  eventName: string
  workflowDispatchSha: string
  defaultBranch: string
}): string {
  const eventName = String(options.eventName ?? "").trim()
  const dispatchSha = String(options.workflowDispatchSha ?? "").trim()
  const branch = String(options.defaultBranch ?? "").trim()
  if (eventName === "workflow_dispatch") {
    if (!dispatchSha) {
      throw new Error("workflow_dispatch tooling ref requires github.sha")
    }
    return dispatchSha
  }
  if (!branch) {
    throw new Error("release tooling ref requires repository.default_branch")
  }
  return `refs/heads/${branch}`
}
