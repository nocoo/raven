import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  buildGhcrTagList,
  readCheckoutHead,
  renderGhcrJobSummary,
  verifyCheckoutHead,
} from "../lib/docker-publish-build.ts"
import type { FetchLike } from "../lib/http-fetch.ts"
import {
  assertDispatchReleasePayload,
  parseVersionReleaseTag,
  resolveReleaseMetadata,
  writeGitHubStepOutput,
} from "../lib/docker-publish-release.ts"

const GOOD_SHA = "f7858e58d51552f996cf187da75d326ccfe6f39c"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("docker publish release validation", () => {
  test("rejects invalid tag strings", () => {
    expect(() => parseVersionReleaseTag("3.3.2")).toThrow(/vX\.Y\.Z/)
    expect(() => parseVersionReleaseTag("v3.3")).toThrow()
    expect(() => parseVersionReleaseTag("")).toThrow()
  })

  test("normalizes dispatch release lookup URLs", async () => {
    let called = ""
    const fetchImpl: FetchLike = async (url) => {
      called = String(url)
      return jsonResponse({
        tag_name: "v3.3.2",
        draft: false,
        prerelease: false,
      })
    }
    await resolveReleaseMetadata({
      eventName: "workflow_dispatch",
      rawTag: "v3.3.2",
      releasePrereleaseFlag: "false",
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com/",
      token: "fixture",
      fetchImpl,
    })
    expect(called).toBe(
      "https://api.github.com/repos/nocoo/raven/releases/tags/v3.3.2",
    )
  })

  test("rejects workflow_dispatch when GitHub release lookup fails", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, { status: 404, statusText: "Not Found" })
    await expect(
      resolveReleaseMetadata({
        eventName: "workflow_dispatch",
        rawTag: "v3.3.2",
        releasePrereleaseFlag: "false",
        repository: "nocoo/raven",
        apiUrl: "https://api.github.com",
        token: "fixture",
        fetchImpl,
      }),
    ).rejects.toThrow(/lookup failed \(404\)/)
  })

  test("rejects draft releases and tag_name mismatches", () => {
    expect(() =>
      assertDispatchReleasePayload("v3.3.2", {
        tag_name: "v3.3.2",
        draft: true,
      }),
    ).toThrow(/draft/)
    expect(() =>
      assertDispatchReleasePayload("v3.3.2", {
        tag_name: "v3.3.1",
        draft: false,
      }),
    ).toThrow(/does not match/)
  })

  test("returns prerelease from dispatch API payload", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        tag_name: "v3.3.2",
        draft: false,
        prerelease: true,
      })
    const meta = await resolveReleaseMetadata({
      eventName: "workflow_dispatch",
      rawTag: "v3.3.2",
      releasePrereleaseFlag: "false",
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      fetchImpl,
    })
    expect(meta.prerelease).toBe(true)
  })

  test("accepts dispatch metadata when release matches", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        tag_name: "v3.3.2",
        draft: false,
        prerelease: false,
      })
    const meta = await resolveReleaseMetadata({
      eventName: "workflow_dispatch",
      rawTag: "v3.3.2",
      releasePrereleaseFlag: "false",
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      fetchImpl,
    })
    expect(meta).toEqual({
      tag: "v3.3.2",
      version: "3.3.2",
      prerelease: false,
    })
  })

  test("rejects invalid repository on dispatch lookup", async () => {
    await expect(
      resolveReleaseMetadata({
        eventName: "workflow_dispatch",
        rawTag: "v3.3.2",
        releasePrereleaseFlag: "false",
        repository: "invalid",
        apiUrl: "https://api.github.com",
        token: "fixture",
        fetchImpl: async () =>
          jsonResponse({
            tag_name: "v3.3.2",
            draft: false,
            prerelease: false,
          }),
      }),
    ).rejects.toThrow(/invalid/)
  })

  test("uses release event prerelease without GitHub API lookup", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("fetch must not run for release events")
    }
    const meta = await resolveReleaseMetadata({
      eventName: "release",
      rawTag: "v3.3.2",
      releasePrereleaseFlag: "true",
      repository: "nocoo/raven",
      apiUrl: "https://api.github.com",
      token: "fixture",
      fetchImpl,
    })
    expect(meta.prerelease).toBe(true)
  })
})

describe("writeGitHubStepOutput", () => {
  test("writes single-line outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "raven-gh-step-"))
    const file = join(dir, "output.txt")
    writeGitHubStepOutput(file, { tag: "v3.3.2", version: "3.3.2" })
    expect(readFileSync(file, "utf8")).toBe("tag=v3.3.2\nversion=3.3.2\n")
  })

  test("rejects multiline values", () => {
    expect(() =>
      writeGitHubStepOutput("/tmp/out", { list: "a\nb" }),
    ).toThrow(/multiline/)
  })
})

describe("docker publish build helpers", () => {
  test("rejects invalid ghcr tag list inputs", () => {
    expect(() =>
      buildGhcrTagList({
        sourceSha: undefined as unknown as string,
        version: "3.3.2",
        prerelease: false,
      }),
    ).toThrow(/40-character/)
    expect(() =>
      buildGhcrTagList({
        sourceSha: "short",
        version: "3.3.2",
        prerelease: false,
      }),
    ).toThrow(/40-character/)
    expect(() =>
      buildGhcrTagList({
        sourceSha: GOOD_SHA,
        version: undefined as unknown as string,
        prerelease: false,
      }),
    ).toThrow(/X\.Y\.Z/)
    expect(() =>
      buildGhcrTagList({
        sourceSha: GOOD_SHA,
        version: "v3.3.2",
        prerelease: false,
      }),
    ).toThrow(/X\.Y\.Z/)
  })

  test("includes semver tags for stable releases", () => {
    expect(
      buildGhcrTagList({
        sourceSha: GOOD_SHA,
        version: "3.3.2",
        prerelease: false,
      }),
    ).toEqual([
      `ghcr.io/nocoo/raven:${GOOD_SHA}`,
      "ghcr.io/nocoo/raven:v3.3.2",
      "ghcr.io/nocoo/raven:3.3.2",
    ])
  })

  test("omits version tags for prerelease builds", () => {
    expect(
      buildGhcrTagList({
        sourceSha: "f7858e58d51552f996cf187da75d326ccfe6f39c",
        version: "3.3.2",
        prerelease: true,
      }),
    ).toEqual([
      "ghcr.io/nocoo/raven:f7858e58d51552f996cf187da75d326ccfe6f39c",
    ])
  })

  test("renders digest-first production reference", () => {
    const text = renderGhcrJobSummary({
      image: "ghcr.io/nocoo/raven",
      tag: "v3.3.2",
      version: "3.3.2",
      digest: "sha256:abc",
      sourceSha: "f7858e58d51552f996cf187da75d326ccfe6f39c",
      sourceRunId: "1",
      prerelease: false,
      platform: "linux/amd64",
    })
    expect(text).toContain("ghcr.io/nocoo/raven@sha256:abc")
    expect(text).not.toContain("ghcr.io/nocoo/raven@v3.3.2")
  })
})

describe("verifyCheckoutHead", () => {
  test("readCheckoutHead returns the repository HEAD", () => {
    expect(readCheckoutHead()).toMatch(/^[a-f0-9]{40}$/)
  })

  test("rejects invalid target sha before reading HEAD", () => {
    let reads = 0
    expect(() =>
      verifyCheckoutHead(undefined as unknown as string, () => {
        reads += 1
        return GOOD_SHA
      }),
    ).toThrow(/40-character/)
    expect(reads).toBe(0)
    expect(() =>
      verifyCheckoutHead("short", () => {
        reads += 1
        return GOOD_SHA
      }),
    ).toThrow(/40-character/)
    expect(reads).toBe(0)
  })

  test("rejects checkout when HEAD differs from proven source", () => {
    expect(() =>
      verifyCheckoutHead(GOOD_SHA, () => "b".repeat(40)),
    ).toThrow(/does not match/)
  })

  test("accepts matching checkout HEAD", () => {
    expect(() =>
      verifyCheckoutHead(GOOD_SHA, () => GOOD_SHA),
    ).not.toThrow()
  })
})
