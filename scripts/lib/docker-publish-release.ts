import type { FetchLike } from "./http-fetch.ts"

export const VERSION_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/

export interface ResolvedReleaseMetadata {
  tag: string
  version: string
  prerelease: boolean
}

export function parseVersionReleaseTag(rawTag: string): {
  tag: string
  version: string
} {
  const tag = String(rawTag ?? "").trim()
  if (!VERSION_TAG_RE.test(tag)) {
    throw new Error("Release tag must match vX.Y.Z")
  }
  return { tag, version: tag.slice(1) }
}

export interface GitHubReleasePayload {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
}

export function assertDispatchReleasePayload(
  tag: string,
  payload: GitHubReleasePayload,
): boolean {
  if (payload.draft) {
    throw new Error(`Release ${tag} is still a draft`)
  }
  if (payload.tag_name !== tag) {
    throw new Error(
      `Release tag_name "${String(payload.tag_name)}" does not match "${tag}"`,
    )
  }
  return Boolean(payload.prerelease)
}

export async function resolveReleaseMetadata(options: {
  eventName: string
  rawTag: string
  releasePrereleaseFlag: string | undefined
  repository: string
  apiUrl: string
  token: string
  fetchImpl?: FetchLike
}): Promise<ResolvedReleaseMetadata> {
  const { tag, version } = parseVersionReleaseTag(options.rawTag)
  let prerelease = options.releasePrereleaseFlag === "true"

  if (options.eventName === "workflow_dispatch") {
    const base = String(options.apiUrl ?? "").replace(/\/$/, "")
    const repo = String(options.repository ?? "").trim()
    if (!repo.includes("/")) {
      throw new Error("GITHUB_REPOSITORY is missing or invalid")
    }
    const response = await (options.fetchImpl ?? fetch)(
      `${base}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    )
    if (!response.ok) {
      throw new Error(
        `GitHub release lookup failed (${response.status}) for tag ${tag}`,
      )
    }
    const payload = (await response.json()) as GitHubReleasePayload
    prerelease = assertDispatchReleasePayload(tag, payload)
  }

  return { tag, version, prerelease }
}

export function writeGitHubStepOutput(
  outputFile: string,
  values: Record<string, string>,
): void {
  const lines = Object.entries(values).map(([key, value]) => {
    if (value.includes("\n")) {
      throw new Error(`Refusing multiline output ${key}`)
    }
    return `${key}=${value}`
  })
  Bun.write(outputFile, `${lines.join("\n")}\n`)
}
