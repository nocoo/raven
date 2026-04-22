// ---------------------------------------------------------------------------
// H.1 — strategy fixtures loader (B.5 shape).
//
// The B.5 fixture envelope `{ request, upstream_raw_chunks[],
// expected_client_events[], expected_end_log }` is shared between Phase C
// goldens and Phase H strategy unit tests. Phase C captured these with field
// names `upstreamChunks` / `responseBody` / `endLog`; the loader normalises to
// the B.5 names so Phase H tests can read either source unchanged.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface StrategyFixture {
  request: { body: Record<string, unknown> }
  /** Raw upstream SSE bytes, one entry per network read. */
  upstreamChunks: string[]
  /** Concatenated SSE bytes the client should ultimately observe. */
  expectedClientBody: string
  /** Field bag merged into Runner's request_end log payload. */
  expectedEndLog: Record<string, unknown>
}

export function loadFixture(name: string): StrategyFixture {
  const raw = JSON.parse(
    readFileSync(join(__dirname, `${name}.json`), "utf8"),
  ) as {
    request: { body: Record<string, unknown> }
    upstreamChunks: string[]
    responseBody: string
    endLog: Record<string, unknown>
  }
  return {
    request: raw.request,
    upstreamChunks: raw.upstreamChunks,
    expectedClientBody: raw.responseBody,
    expectedEndLog: raw.endLog,
  }
}

export const FIXTURE_NAMES = [
  "copilot-openai-direct",
  "copilot-responses",
  "copilot-translated",
  "custom-anthropic",
  "custom-openai-from-anthropic-client",
  "custom-openai-from-openai-client",
] as const
