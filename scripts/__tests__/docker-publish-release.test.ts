import { describe, expect, test } from "vitest"
import { buildGhcrTagList, renderGhcrJobSummary } from "../lib/docker-publish-build.ts"
import {
  assertDispatchReleasePayload,
  parseVersionReleaseTag,
  resolveReleaseMetadata,
} from "../lib/docker-publish-release.ts"

describe("docker publish release validation", () => {
  test("rejects invalid tag strings", () => {
    expect(() => parseVersionReleaseTag("3.3.2")).toThrow(/vX\.Y\.Z/)
    expect(() => parseVersionReleaseTag("v3.3")).toThrow()
  })

  test("rejects workflow_dispatch when GitHub release lookup fails", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 }) as Response
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

  test("accepts dispatch metadata when release matches", async () => {
    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v3.3.2",
          draft: false,
          prerelease: false,
        }),
      }) as Response
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

  test("uses release event prerelease without GitHub API lookup", async () => {
    const fetchImpl = async () => {
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

describe("docker publish build helpers", () => {
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
