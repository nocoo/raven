import type { FetchLike } from "./http-fetch.ts"

export const DEFAULT_CI_WAIT_MS = 30 * 60 * 1000
export const DEFAULT_CI_POLL_MS = 30 * 1000

const SHA_RE = /^[a-f0-9]{40}$/i
const WORKFLOW_FILE = "ci.yml"

export interface CiWaitConfig {
  repository: string
  apiUrl: string
  token: string
  tag: string
  expectedWorkflowPath: string
  expectedWorkflowName: string
  expectedBranch: string
  timeoutMs?: number
  pollMs?: number
  fetchImpl?: FetchLike
  sleepMs?: (ms: number) => Promise<void>
  now?: () => number
}

export interface CiWaitResult {
  targetSha: string
  runId: number
}

interface WorkflowRunListItem {
  id?: number
  head_sha?: string
  status?: string
  conclusion?: string | null
  path?: string
  name?: string
  head_branch?: string
  event?: string
}

async function githubJson(
  fetchImpl: FetchLike,
  url: string,
  token: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`)
  }
  return response.json()
}

function normalizeSha(value: string, label: string): string {
  const sha = String(value ?? "").trim().toLowerCase()
  if (!SHA_RE.test(sha)) {
    throw new Error(`${label} must be a 40-character commit SHA`)
  }
  return sha
}

export async function peelReleaseTag(
  options: Pick<CiWaitConfig, "repository" | "apiUrl" | "token" | "tag" | "fetchImpl">,
): Promise<string> {
  const base = String(options.apiUrl ?? "").replace(/\/$/, "")
  const repo = String(options.repository ?? "").trim()
  const tag = String(options.tag ?? "").trim()
  const fetchImpl = options.fetchImpl ?? fetch
  const ref = (await githubJson(
    fetchImpl,
    `${base}/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
    options.token,
  )) as { object?: { type?: string; sha?: string } }
  const object = ref.object
  if (object?.type !== "commit") {
    if (object?.type === "tag" && object.sha) {
      const annotated = (await githubJson(
        fetchImpl,
        `${base}/repos/${repo}/git/tags/${normalizeSha(object.sha, "tag object")}`,
        options.token,
      )) as { object?: { type?: string; sha?: string } }
      if (annotated.object?.type !== "commit" || !annotated.object.sha) {
        throw new Error(`Annotated tag ${tag} did not peel to a commit`)
      }
      return normalizeSha(annotated.object.sha, `tag ${tag}`)
    }
    throw new Error(`Tag ${tag} did not resolve to a commit`)
  }
  return normalizeSha(object.sha ?? "", `tag ${tag}`)
}

function matchesTrustedCiRun(
  run: WorkflowRunListItem,
  expected: Pick<
    CiWaitConfig,
    "expectedWorkflowPath" | "expectedWorkflowName" | "expectedBranch"
  >,
  targetSha: string,
): boolean {
  const headSha = String(run.head_sha ?? "").trim().toLowerCase()
  if (headSha !== targetSha) return false
  if (run.path !== expected.expectedWorkflowPath) return false
  if (run.name !== expected.expectedWorkflowName) return false
  if (run.head_branch !== expected.expectedBranch) return false
  if (run.event !== "push") return false
  return true
}

export async function waitForTrustedCiSuccess(
  options: CiWaitConfig,
): Promise<CiWaitResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_CI_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_CI_POLL_MS
  const sleepMs = options.sleepMs ?? ((ms: number) => Bun.sleep(ms))
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs

  const targetSha = await peelReleaseTag(options)
  const base = String(options.apiUrl ?? "").replace(/\/$/, "")
  const repo = String(options.repository ?? "").trim()
  const runsUrl = `${base}/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${encodeURIComponent(targetSha)}&per_page=30`

  while (now() <= deadline) {
    const payload = (await githubJson(fetchImpl, runsUrl, options.token)) as {
      workflow_runs?: WorkflowRunListItem[]
    }
    const runs = Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs
      : []

    for (const run of runs) {
      if (!matchesTrustedCiRun(run, options, targetSha)) continue
      if (run.status !== "completed") continue
      const conclusion = run.conclusion ?? ""
      const runId = Number(run.id)
      if (!Number.isInteger(runId) || runId <= 0) {
        throw new Error("Trusted CI run is missing a valid id")
      }
      if (conclusion === "success") {
        return { targetSha, runId }
      }
      throw new Error(
        `Trusted CI run ${runId} completed with conclusion "${conclusion}"`,
      )
    }

    if (now() + pollMs > deadline) break
    await sleepMs(pollMs)
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for successful CI on ${targetSha}`,
  )
}
