import { describe, expect, test } from "vitest"
import type { FetchLike } from "../lib/http-fetch.ts"
import {
  DEFAULT_CI_POLL_MS,
  peelReleaseTag,
  waitForTrustedCiSuccess,
} from "../lib/docker-publish-wait-ci.ts"

const TAG_SHA = "f7858e58d51552f996cf187da75d326ccfe6f39c"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const peelFetch: FetchLike = async (url) => {
  if (String(url).includes("/git/ref/tags/v3.3.2")) {
    return jsonResponse({
      object: { type: "commit", sha: TAG_SHA },
    })
  }
  throw new Error(`unexpected peel url ${String(url)}`)
}

describe("waitForTrustedCiSuccess", () => {
  test("returns when trusted CI completes green", async () => {
    let polls = 0
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/git/ref/tags/")) {
        return peelFetch(url)
      }
      polls += 1
      if (polls === 1) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 99,
              head_sha: TAG_SHA,
              status: "in_progress",
              path: ".github/workflows/ci.yml",
              name: "CI",
              head_branch: "main",
              event: "push",
            },
          ],
        })
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 99,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
        ],
      })
    }

    const result = await waitForTrustedCiSuccess({
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      tag: "v3.3.2",
      expectedWorkflowPath: ".github/workflows/ci.yml",
      expectedWorkflowName: "CI",
      expectedBranch: "main",
      timeoutMs: 5_000,
      pollMs: 1,
      fetchImpl,
      sleepMs: async () => undefined,
      now: () => 0,
    })

    expect(result).toEqual({ targetSha: TAG_SHA, runId: 99 })
    expect(polls).toBe(2)
  })

  test("fails closed on completed red trusted CI", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/git/ref/tags/")) {
        return peelFetch(url)
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 42,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "failure",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
        ],
      })
    }

    await expect(
      waitForTrustedCiSuccess({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        expectedWorkflowPath: ".github/workflows/ci.yml",
        expectedWorkflowName: "CI",
        expectedBranch: "main",
        timeoutMs: 1_000,
        pollMs: DEFAULT_CI_POLL_MS,
        fetchImpl,
        sleepMs: async () => undefined,
        now: () => 0,
      }),
    ).rejects.toThrow(/conclusion "failure"/)
  })

  test("ignores non-matching head sha, path, name, and branch", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/git/ref/tags/")) {
        return peelFetch(url)
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            head_sha: "a".repeat(40),
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
          {
            id: 2,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/other.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
          {
            id: 3,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "Other",
            head_branch: "main",
            event: "push",
          },
          {
            id: 4,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "develop",
            event: "push",
          },
          {
            id: 55,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
        ],
      })
    }
    const result = await waitForTrustedCiSuccess({
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      tag: "v3.3.2",
      expectedWorkflowPath: ".github/workflows/ci.yml",
      expectedWorkflowName: "CI",
      expectedBranch: "main",
      fetchImpl,
    })
    expect(result.runId).toBe(55)
  })

  test("ignores workflow runs that do not match the trusted contract", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/git/ref/tags/")) {
        return peelFetch(url)
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "workflow_dispatch",
          },
          {
            id: 88,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
        ],
      })
    }
    const result = await waitForTrustedCiSuccess({
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      tag: "v3.3.2",
      expectedWorkflowPath: ".github/workflows/ci.yml",
      expectedWorkflowName: "CI",
      expectedBranch: "main",
      fetchImpl,
    })
    expect(result.runId).toBe(88)
  })

  test("times out when CI never succeeds", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/git/ref/tags/")) {
        return peelFetch(url)
      }
      return jsonResponse({ workflow_runs: [] })
    }
    let tick = 0
    await expect(
      waitForTrustedCiSuccess({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        expectedWorkflowPath: ".github/workflows/ci.yml",
        expectedWorkflowName: "CI",
        expectedBranch: "main",
        timeoutMs: 5,
        pollMs: 2,
        fetchImpl,
        sleepMs: async () => undefined,
        now: () => {
          tick += 2
          return tick
        },
      }),
    ).rejects.toThrow(/Timed out after 5ms/)
  })
})

describe("peelReleaseTag", () => {
  test("peels lightweight tag commits", async () => {
    const sha = await peelReleaseTag({
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      tag: "v3.3.2",
      fetchImpl: peelFetch,
    })
    expect(sha).toBe(TAG_SHA)
  })

  test("peels annotated tag objects", async () => {
    const annotatedFetch: FetchLike = async (url) => {
      const text = String(url)
      if (text.includes("/git/ref/tags/")) {
        return jsonResponse({
          object: { type: "tag", sha: "a".repeat(40) },
        })
      }
      if (text.includes("/git/tags/")) {
        return jsonResponse({
          object: { type: "commit", sha: TAG_SHA },
        })
      }
      throw new Error(`unexpected url ${text}`)
    }
    const sha = await peelReleaseTag({
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      tag: "v3.3.2",
      fetchImpl: annotatedFetch,
    })
    expect(sha).toBe(TAG_SHA)
  })

  test("rejects annotated tags that do not peel to commits", async () => {
    const fetchImpl: FetchLike = async (url) => {
      const text = String(url)
      if (text.includes("/git/ref/tags/")) {
        return jsonResponse({
          object: { type: "tag", sha: "c".repeat(40) },
        })
      }
      if (text.includes("/git/tags/")) {
        return jsonResponse({
          object: { type: "blob", sha: TAG_SHA },
        })
      }
      throw new Error(`unexpected url ${text}`)
    }
    await expect(
      peelReleaseTag({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        fetchImpl,
      }),
    ).rejects.toThrow(/did not peel/)
  })

  test("rejects invalid commit shas from tag objects", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ object: { type: "commit", sha: "not-a-sha" } })
    await expect(
      peelReleaseTag({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        fetchImpl,
      }),
    ).rejects.toThrow(/40-character/)
  })

  test("rejects annotated tags without tag object sha", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ object: { type: "tag" } })
    await expect(
      peelReleaseTag({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        fetchImpl,
      }),
    ).rejects.toThrow(/did not resolve/)
  })

  test("rejects unknown tag object types", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ object: { type: "blob", sha: "b".repeat(40) } })
    await expect(
      peelReleaseTag({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        fetchImpl,
      }),
    ).rejects.toThrow(/did not resolve/)
  })
})

describe("waitForTrustedCiSuccess errors", () => {
  test("fails on completed trusted CI with empty conclusion", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/git/ref/tags/")) {
        return peelFetch(url)
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 7,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: null,
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
        ],
      })
    }
    await expect(
      waitForTrustedCiSuccess({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        expectedWorkflowPath: ".github/workflows/ci.yml",
        expectedWorkflowName: "CI",
        expectedBranch: "main",
        fetchImpl,
      }),
    ).rejects.toThrow(/conclusion ""/)
  })

  test("fails when trusted CI run id is invalid", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/git/ref/tags/")) {
        return peelFetch(url)
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 0,
            head_sha: TAG_SHA,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/ci.yml",
            name: "CI",
            head_branch: "main",
            event: "push",
          },
        ],
      })
    }
    await expect(
      waitForTrustedCiSuccess({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        expectedWorkflowPath: ".github/workflows/ci.yml",
        expectedWorkflowName: "CI",
        expectedBranch: "main",
        fetchImpl,
      }),
    ).rejects.toThrow(/valid id/)
  })

  test("fails when GitHub API returns an error", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, { status: 500 })
    await expect(
      waitForTrustedCiSuccess({
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        tag: "v3.3.2",
        expectedWorkflowPath: ".github/workflows/ci.yml",
        expectedWorkflowName: "CI",
        expectedBranch: "main",
        fetchImpl,
      }),
    ).rejects.toThrow(/GitHub API 500/)
  })
})
