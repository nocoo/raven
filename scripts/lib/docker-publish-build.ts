import { execSync } from "node:child_process"

export const GHCR_IMAGE = "ghcr.io/nocoo/raven"

const SHA_RE = /^[a-f0-9]{40}$/i

export function buildGhcrTagList(options: {
  sourceSha: string
  version: string
  prerelease: boolean
}): string[] {
  const sha = String(options.sourceSha ?? "").trim().toLowerCase()
  if (!SHA_RE.test(sha)) {
    throw new Error("RELEASE_SOURCE_SHA must be a 40-character commit SHA")
  }
  const version = String(options.version ?? "").trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("RELEASE_VERSION must match X.Y.Z")
  }
  const names = [`${GHCR_IMAGE}:${sha}`]
  if (!options.prerelease) {
    names.push(`${GHCR_IMAGE}:v${version}`, `${GHCR_IMAGE}:${version}`)
  }
  return names
}

export function verifyCheckoutHead(targetSha: string): void {
  const expected = String(targetSha ?? "").trim().toLowerCase()
  if (!SHA_RE.test(expected)) {
    throw new Error("TARGET_SHA must be a 40-character commit SHA")
  }
  const head = execSync("git rev-parse HEAD", { encoding: "utf8" })
    .trim()
    .toLowerCase()
  if (head !== expected) {
    throw new Error(
      `Checkout HEAD ${head} does not match proven source ${expected}`,
    )
  }
}

export interface GhcrReleaseManifest {
  image: string
  tag: string
  version: string
  digest: string
  sourceSha: string
  sourceRunId: string
  prerelease: boolean
  platform: string
}

export function renderGhcrJobSummary(manifest: GhcrReleaseManifest): string {
  return [
    "## Raven GHCR image",
    "",
    `- **Digest (content identity):** \`${manifest.digest}\``,
    `- **Source revision:** \`${manifest.sourceSha}\``,
    `- **Release tag:** \`${manifest.tag}\``,
    `- **Version:** \`${manifest.version}\``,
    `- **CI run ID:** \`${manifest.sourceRunId}\``,
    `- **Platform:** \`${manifest.platform}\``,
    "",
    "Reference by digest for production:",
    "",
    `\`${manifest.image}@${manifest.digest}\``,
    "",
    "Tags also point at this build; prefer digest pinning because tags can move.",
  ].join("\n")
}
