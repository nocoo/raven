const SHA_RE = /^[a-f0-9]{40}$/i

/**
 * Workflow tooling must track the workflow definition that GitHub Actions loaded:
 * - release:published pins github.workflow_sha (default-branch commit at trigger; immutable for the run)
 * - workflow_dispatch uses the selected branch head (github.sha)
 */
export function resolveDockerPublishToolingRef(options: {
  eventName: string
  workflowDispatchSha: string
  releaseWorkflowSha: string
}): string {
  const eventName = String(options.eventName ?? "").trim()
  const dispatchSha = String(options.workflowDispatchSha ?? "").trim()
  const workflowSha = String(options.releaseWorkflowSha ?? "").trim().toLowerCase()
  if (eventName === "workflow_dispatch") {
    if (!dispatchSha) {
      throw new Error("workflow_dispatch tooling ref requires github.sha")
    }
    return dispatchSha
  }
  if (!SHA_RE.test(workflowSha)) {
    throw new Error("release tooling ref requires github.workflow_sha")
  }
  return workflowSha
}
