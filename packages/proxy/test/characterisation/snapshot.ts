// Phase G.1 characterisation harness — snapshots the byte-level SSE
// response body and the scrubbed `request_end` log field bag for each
// streaming handler branch. The snapshots become the diff targets that
// G.6–G.12 must reproduce exactly when the branch is ported onto Runner.
//
// Mode is selected at runtime:
//   - RAVEN_CAPTURE_CHARACTERISATION=1 → write the live capture to disk
//   - default                         → load the on-disk snapshot and
//                                       byte-compare. Missing snapshot
//                                       fails loudly.
//
// The harness intentionally does not depend on the e2e capture pipeline
// (`test/e2e/refactor/`): characterisation runs at L1, with `globalThis.fetch`
// spied and Hono executed in-process. There is no proxy, no WebSocket, no
// upstream — every byte we record came out of the real handler under test.

import { expect } from "bun:test"

export interface CharacterisationRequest {
  method: "POST"
  path: string
  headers?: Record<string, string>
  body: unknown
}

export interface CharacterisationSnapshot {
  version: 1
  branch: string
  request: CharacterisationRequest
  upstreamChunks: string[]
  responseStatus: number
  responseHeaders: Record<string, string>
  responseBody: string
  endLog: Record<string, unknown>
}

const VOLATILE_END_LOG_KEYS = new Set([
  "latencyMs", "ttftMs", "processingMs",
  "sessionId", "accountName", "clientName", "clientVersion",
])

export function scrubEndLog(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (VOLATILE_END_LOG_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

export function scrubResponseHeaders(h: Headers): Record<string, string> {
  // Response-side fields are stable for streaming branches (content-type),
  // but Hono adds per-request transfer-encoding; keep only headers we
  // actually want to pin in the byte-level diff target.
  const keep = new Set(["content-type", "transfer-encoding"])
  const out: Record<string, string> = {}
  for (const [k, v] of h.entries()) {
    if (keep.has(k.toLowerCase())) out[k.toLowerCase()] = v
  }
  return out
}

const SNAPSHOT_ROOT = `${import.meta.dir}/__snapshots__`

export async function captureOrDiff(snapshot: CharacterisationSnapshot): Promise<void> {
  const path = `${SNAPSHOT_ROOT}/${snapshot.branch}.json`
  const file = Bun.file(path)
  const captureMode = process.env.RAVEN_CAPTURE_CHARACTERISATION === "1"

  if (captureMode) {
    await Bun.write(path, JSON.stringify(snapshot, null, 2) + "\n")
    return
  }

  if (!(await file.exists())) {
    throw new Error(
      `characterisation snapshot missing: ${path}\n`
      + `  Run with RAVEN_CAPTURE_CHARACTERISATION=1 to create it.`,
    )
  }

  const stored = JSON.parse(await file.text()) as CharacterisationSnapshot
  // Byte-level diff for the SSE body — this is the single most
  // regression-prone surface during G.6–G.12.
  expect(snapshot.responseStatus).toBe(stored.responseStatus)
  expect(snapshot.responseHeaders).toEqual(stored.responseHeaders)
  expect(snapshot.responseBody).toBe(stored.responseBody)
  expect(snapshot.endLog).toEqual(stored.endLog)
  // Upstream chunks are recorded for traceability — they're inputs we
  // controlled, but pinning them guards against the test driver itself
  // drifting.
  expect(snapshot.upstreamChunks).toEqual(stored.upstreamChunks)
}
