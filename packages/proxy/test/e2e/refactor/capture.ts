/**
 * §4.3 fixture capture / diff harness (C.0b).
 *
 * Connects to the proxy's WebSocket log stream, correlates one HTTP
 * request by (cutoff-ts, path, model), collects its `request_start`,
 * `upstream_raw_sse`, `request_end` events, assembles a B.5
 * GoldenFixture, and either:
 *   - writes it to disk when RAVEN_CAPTURE_GOLDENS=1
 *   - diffs it against the stored fixture otherwise
 *
 * The WS-correlation approach avoids needing the proxy to echo a
 * request id back in its response — the stream carries requestId on
 * every event, and request_start pins it to the caller's path+model.
 */

import type { Subprocess } from "bun"
import {
  parseGoldenFixture,
  serialiseGoldenFixture,
  type FixtureEndLog,
  type FixtureRequest,
  type GoldenFixture,
  type RawSseEvent,
} from "./fixture-format"
import { consumeSSE, normaliseEvents, PROXY, API_KEY, type SseEvent } from "./helpers"

export interface CaptureScenarioRef {
  /** Pre-resolved path under `__golden__/` (matches scenarios.json). */
  goldenPath: string
  /** Model id that will appear in request_start.data.model. */
  model: string
}

export interface CaptureResult {
  /** Whether the fixture was written to disk (capture mode) or compared. */
  mode: "capture" | "diff"
  /** The assembled fixture (live). */
  live: GoldenFixture
  /** The on-disk fixture in diff mode; null in capture mode. */
  stored: GoldenFixture | null
}

/** Subset of fields we read from the proxy log stream. */
interface StreamedLogEvent {
  ts: number
  type: string
  requestId: string | null
  data?: Record<string, unknown> | null
}

interface CorrelatedEvents {
  requestId: string
  requestStart: StreamedLogEvent
  upstreamRaw: StreamedLogEvent[]
  requestEnd: StreamedLogEvent
}

const VOLATILE_END_LOG_KEYS = new Set([
  "latencyMs", "ttftMs", "processingMs",
  "sessionId", "clientVersion",
  "accountName", "clientName",
])

/** Build the B.5 expected_end_log from a raw request_end log event,
 *  keeping only the refactor-invariant fields plus a scrubbed extras
 *  bag. Volatile keys (latencies, identity blobs) are dropped so diffs
 *  surface only structural regressions. */
export function buildEndLog(raw: Record<string, unknown>): FixtureEndLog {
  const {
    path, format, model, stream, status, statusCode, upstreamStatus,
    inputTokens, outputTokens,
    ...rest
  } = raw
  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rest)) {
    if (VOLATILE_END_LOG_KEYS.has(k)) continue
    extras[k] = v
  }
  return {
    path: String(path),
    format: String(format),
    model: String(model),
    stream: Boolean(stream),
    status: (status === "error" ? "error" : "success"),
    statusCode: Number(statusCode),
    upstreamStatus: typeof upstreamStatus === "number" ? upstreamStatus : null,
    inputTokens: typeof inputTokens === "number" ? inputTokens : 0,
    outputTokens: typeof outputTokens === "number" ? outputTokens : 0,
    extras,
  }
}

/** Convert a streamed `upstream_raw_sse` event into the fixture form. */
export function rawEventFromLog(data: Record<string, unknown>): RawSseEvent {
  const ev = data.event
  const body = data.data
  const out: RawSseEvent = { data: typeof body === "string" ? body : "" }
  if (typeof ev === "string" && ev.length > 0) out.event = ev
  return out
}

/**
 * Subscribe to the proxy WS log stream and resolve when we observe a
 * request_start matching (path, model, ts ≥ cutoff) followed by its
 * request_end. Returns the correlated events or rejects on timeout.
 */
export async function waitForRequest(opts: {
  cutoffTs: number
  path: string
  model: string
  timeoutMs?: number
}): Promise<CorrelatedEvents> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const wsUrl = buildWsUrl()
  const ws = new WebSocket(wsUrl)

  return await new Promise<CorrelatedEvents>((resolve, reject) => {
    let requestId: string | null = null
    const upstreamRaw: StreamedLogEvent[] = []
    let requestStart: StreamedLogEvent | null = null
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(
        `timed out after ${String(timeoutMs)}ms waiting for request_end `
        + `(path=${opts.path} model=${opts.model})`,
      ))
    }, timeoutMs)

    ws.addEventListener("message", (m: MessageEvent) => {
      let ev: StreamedLogEvent
      try {
        ev = JSON.parse(String(m.data)) as StreamedLogEvent
      } catch {
        return
      }
      // Match the request on its request_start; after that, filter by requestId.
      if (requestId === null) {
        if (
          ev.type === "request_start"
          && ev.ts >= opts.cutoffTs
          && (ev.data?.path === opts.path)
          && (ev.data?.model === opts.model)
        ) {
          requestId = ev.requestId
          requestStart = ev
        }
        return
      }
      if (ev.requestId !== requestId) return
      if (ev.type === "upstream_raw_sse") {
        upstreamRaw.push(ev)
        return
      }
      if (ev.type === "request_end" && requestStart) {
        clearTimeout(timer)
        ws.close()
        resolve({ requestId, requestStart, upstreamRaw, requestEnd: ev })
      }
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`WS error on ${wsUrl}`))
    })
  })
}

function buildWsUrl(): string {
  const proxyUrl = new URL(PROXY)
  const ws = new URL(proxyUrl.toString())
  ws.protocol = proxyUrl.protocol === "https:" ? "wss:" : "ws:"
  ws.pathname = "/ws/logs"
  ws.search = `?level=debug${API_KEY ? `&token=${encodeURIComponent(API_KEY)}` : ""}`
  return ws.toString()
}

/**
 * Pure fixture assembler — takes the correlated stream + the client-side
 * response events and produces a GoldenFixture. Kept pure so L1 tests
 * can cover it without touching WebSockets or the filesystem.
 */
export function assembleFixture(input: {
  request: FixtureRequest
  upstreamRaw: StreamedLogEvent[]
  clientEvents: SseEvent[]
  requestEnd: StreamedLogEvent
}): GoldenFixture {
  const upstream_raw_chunks: RawSseEvent[] = input.upstreamRaw
    .map((ev) => rawEventFromLog(ev.data ?? {}))
  const expected_client_events = normaliseEvents(input.clientEvents).map(
    (ev) => ev.event !== undefined ? { event: ev.event, data: ev.data } : { data: ev.data },
  )
  const expected_end_log = buildEndLog(input.requestEnd.data ?? {})
  return {
    fixtureVersion: 1,
    request: input.request,
    upstream_raw_chunks,
    expected_client_events,
    expected_end_log,
  }
}

export interface CaptureOrDiffOpts {
  scenario: CaptureScenarioRef
  request: FixtureRequest
  /**
   * Perform the actual HTTP POST to the proxy and return the response.
   * Kept as a callback so callers can tune headers/body per scenario.
   */
  fetchResponse: () => Promise<Response>
  /**
   * Resolves paths of the form `__golden__/<goldenPath>` under
   * packages/proxy/test/e2e/refactor/. Overridable for unit testing.
   */
  goldenRoot?: string
}

/**
 * High-level harness: subscribe → fire request → collect → assemble.
 * Writes the fixture to disk when RAVEN_CAPTURE_GOLDENS=1; otherwise
 * loads and returns the stored fixture alongside live for diffing.
 */
export async function captureOrDiffFixture(
  opts: CaptureOrDiffOpts,
  /** Injected to keep this function testable without hitting a proxy. */
  deps: {
    waitForRequest?: typeof waitForRequest
    write?: (path: string, body: string) => Promise<void>
    readIfExists?: (path: string) => Promise<string | null>
  } = {},
): Promise<CaptureResult> {
  const wait = deps.waitForRequest ?? waitForRequest
  const write = deps.write ?? (async (p, body) => { await Bun.write(p, body) })
  const readIfExists = deps.readIfExists ?? (async (p) => {
    const f = Bun.file(p)
    return (await f.exists()) ? await f.text() : null
  })
  const goldenRoot = opts.goldenRoot
    ?? `${import.meta.dir}/__golden__`

  const cutoffTs = Date.now()
  const waitPromise = wait({ cutoffTs, path: opts.request.path, model: extractModel(opts.request.body) })
  const response = await opts.fetchResponse()
  const clientEvents = await consumeSSE(response.clone())
  const correlated = await waitPromise

  const live = assembleFixture({
    request: opts.request,
    upstreamRaw: correlated.upstreamRaw,
    clientEvents,
    requestEnd: correlated.requestEnd,
  })

  const fullPath = `${goldenRoot}/${opts.scenario.goldenPath}`
  const capture = process.env.RAVEN_CAPTURE_GOLDENS === "1"
  if (capture) {
    await write(fullPath, serialiseGoldenFixture(live))
    return { mode: "capture", live, stored: live }
  }
  const raw = await readIfExists(fullPath)
  const stored = raw === null ? null : parseGoldenFixture(raw)
  return { mode: "diff", live, stored }
}

function extractModel(body: unknown): string {
  if (body && typeof body === "object" && "model" in body) {
    const m = (body as { model: unknown }).model
    if (typeof m === "string") return m
  }
  return ""
}

/**
 * Utility for local tests that want a proxy subprocess — not used by
 * this module's own tests, exported so future capture scripts can bring
 * up a proxy without duplicating boilerplate. Kept here to keep the
 * capture surface area in one file.
 */
export type ProxyProcess = Subprocess
