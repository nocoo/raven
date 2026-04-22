#!/usr/bin/env bun
/**
 * Phase E.11 — `fetch()` boundary guard.
 *
 * §3.7 of docs/20-architecture-refactor.md:
 *   "upstream/ is the only layer allowed to call fetch."
 *
 * This applies to outbound LLM-upstream calls. A small set of non-LLM
 * fetch sites (GitHub auth, Tavily server-tool, provider probes, model
 * catalog refresh, VSCode version probe, the Hono server's own request
 * handler) predate the refactor and are not in scope for E.11.
 * They are listed in ALLOWED_NON_UPSTREAM_FETCH below; new entries
 * require explicit review.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..", "packages", "proxy", "src")
const UPSTREAM_PREFIX = "upstream/"
const FETCH_PATTERN = /(?<![./_a-zA-Z0-9])fetch\s*\(/

const ALLOWED_NON_UPSTREAM_FETCH = new Set<string>([
  // Hono server entrypoint — receives inbound requests, does not initiate
  // outbound LLM traffic.
  "index.ts",
  // GitHub auth + Copilot meta (token refresh, user info, usage, device flow)
  "services/github/get-user.ts",
  "services/github/get-copilot-usage.ts",
  "services/github/get-device-code.ts",
  "services/github/get-copilot-token.ts",
  "services/github/poll-access-token.ts",
  // VSCode version probe (Marketplace).
  "services/get-vscode-version.ts",
  // Copilot model catalog refresh — read-only, not an LLM call.
  "services/copilot/get-models.ts",
  // Tavily web-search server-tool.
  "lib/server-tools/tavily.ts",
  // Admin / management routes (provider probes, models list, connection
  // info, SOCKS5 settings UI).
  "routes/connection-info.ts",
  "routes/models/route.ts",
  "routes/upstreams.ts",
  "routes/settings-socks5.ts",
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith(".ts")) yield full
  }
}

function isComment(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  )
}

const violations: { file: string; line: number; text: string }[] = []
const unusedAllowList = new Set(ALLOWED_NON_UPSTREAM_FETCH)

for (const abs of walk(ROOT)) {
  const rel = relative(ROOT, abs)
  if (rel.startsWith(UPSTREAM_PREFIX)) continue
  const src = readFileSync(abs, "utf8").split("\n")
  let hasFetch = false
  for (let i = 0; i < src.length; i++) {
    const line = src[i]!
    if (isComment(line)) continue
    if (FETCH_PATTERN.test(line)) {
      hasFetch = true
      if (!ALLOWED_NON_UPSTREAM_FETCH.has(rel)) {
        violations.push({ file: rel, line: i + 1, text: line.trim() })
      }
    }
  }
  if (hasFetch) unusedAllowList.delete(rel)
}

if (violations.length > 0) {
  console.error("❌ fetch() boundary violation (Phase E.11)")
  console.error(
    "Only packages/proxy/src/upstream/ may call fetch(). Move the call into",
    "an UpstreamClient, or add the file to ALLOWED_NON_UPSTREAM_FETCH",
    "in scripts/check-fetch-boundary.ts (with reviewer approval).",
  )
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`)
  }
  process.exit(1)
}

if (unusedAllowList.size > 0) {
  console.error("❌ stale entries in ALLOWED_NON_UPSTREAM_FETCH:")
  for (const f of unusedAllowList) console.error(`  ${f}`)
  console.error("Remove them from scripts/check-fetch-boundary.ts.")
  process.exit(1)
}

console.log("✅ fetch() boundary check passed")
