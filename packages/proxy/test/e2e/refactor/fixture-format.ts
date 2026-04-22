/**
 * §4.3 golden fixture format — frozen by B.5.
 *
 * Single shared shape consumed by:
 *   - Phase C (E2E diff against live upstream)
 *   - Phase H (`adaptChunk` unit tests replay `upstream_raw_chunks`
 *     and assert against `expected_client_events` / `expected_end_log`)
 *
 * The capture pipeline records raw upstream SSE chunks (pre-translation)
 * so strategy unit tests can replay them deterministically without
 * re-calling upstream. The client-facing events and request_end payload
 * are recorded post-translation so Phase C can diff end-to-end.
 *
 * Any change to this shape is a protocol-level event that requires
 * re-capturing every golden — do not evolve it silently.
 */

/** One Server-Sent-Event (event name optional for `data:`-only lines). */
export interface RawSseEvent {
  event?: string
  data: string
}

/** Subset of Anthropic Messages / OpenAI ChatCompletions request kept
 *  in the fixture. Kept loose — the capture pipeline records whatever
 *  the client sent; downstream consumers read only the fields they need. */
export interface FixtureRequest {
  method: "POST"
  path: string
  headers?: Record<string, string>
  body: unknown
}

/**
 * Final shape of a request_end log entry, reduced to the
 * refactor-invariant fields defined in §3.5 "describeEndLog" contract.
 * Volatile fields (ids, timestamps, latencies) are scrubbed during
 * capture so diffs highlight only structural changes.
 */
export interface FixtureEndLog {
  path: string
  format: string
  model: string
  stream: boolean
  status: "success" | "error"
  statusCode: number
  upstreamStatus: number | null
  inputTokens: number
  outputTokens: number
  /** Additional strategy-specific fields (resolvedModel, translatedModel,
   *  upstream, routingPath, ...) — recorded verbatim after scrubbing. */
  extras: Record<string, unknown>
}

/** The B.5 fixture format. Every field is required — capture must
 *  populate all four slots. Missing data is a capture bug, not a
 *  fixture feature. */
export interface GoldenFixture {
  /** Schema version for the fixture format itself. Bump when the
   *  shape evolves so stale fixtures are rejected loudly rather than
   *  silently misinterpreted. */
  fixtureVersion: 1
  /** Request the client sent to the proxy. */
  request: FixtureRequest
  /** Raw SSE chunks the proxy received from the upstream (before any
   *  translation). For non-streaming upstream responses this is a
   *  single synthetic event carrying the JSON body. */
  upstream_raw_chunks: RawSseEvent[]
  /** Events the proxy emitted to the client, normalised via
   *  `normaliseEvents` (volatile fields scrubbed). */
  expected_client_events: RawSseEvent[]
  /** Scrubbed `request_end` log entry. */
  expected_end_log: FixtureEndLog
}

/** Runtime-valid check: a parsed JSON blob claims to be a fixture of
 *  the current version. Throws with a pointer to the offending field
 *  so capture/diff tools can surface actionable errors. */
export function assertGoldenFixture(x: unknown): asserts x is GoldenFixture {
  if (typeof x !== "object" || x === null) {
    throw new Error("fixture must be an object")
  }
  const o = x as Record<string, unknown>
  if (o.fixtureVersion !== 1) {
    throw new Error(`fixture.fixtureVersion must be 1, got ${JSON.stringify(o.fixtureVersion)}`)
  }
  if (typeof o.request !== "object" || o.request === null) {
    throw new Error("fixture.request must be an object")
  }
  const req = o.request as Record<string, unknown>
  if (req.method !== "POST" || typeof req.path !== "string") {
    throw new Error("fixture.request must have method=POST and a string path")
  }
  if (!Array.isArray(o.upstream_raw_chunks)) {
    throw new Error("fixture.upstream_raw_chunks must be an array")
  }
  if (!Array.isArray(o.expected_client_events)) {
    throw new Error("fixture.expected_client_events must be an array")
  }
  if (typeof o.expected_end_log !== "object" || o.expected_end_log === null) {
    throw new Error("fixture.expected_end_log must be an object")
  }
  const end = o.expected_end_log as Record<string, unknown>
  for (const k of ["path", "format", "model", "stream", "status", "statusCode"] as const) {
    if (!(k in end)) throw new Error(`fixture.expected_end_log missing ${k}`)
  }
}

/** Parse a fixture file's text content; throws with context on
 *  malformed JSON or wrong shape. */
export function parseGoldenFixture(raw: string): GoldenFixture {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `fixture is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  assertGoldenFixture(parsed)
  return parsed
}

/** Serialise a fixture for writing to disk. Uses 2-space JSON with a
 *  trailing newline so `git diff` on re-captures shows minimal churn. */
export function serialiseGoldenFixture(f: GoldenFixture): string {
  assertGoldenFixture(f) // catch drift at serialise time, not at load
  return JSON.stringify(f, null, 2) + "\n"
}
