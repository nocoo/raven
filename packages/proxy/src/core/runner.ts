// ---------------------------------------------------------------------------
// core/runner.ts — generic executor for the symmetric pipeline (§3.5).
//
// Coverage paths per §4.5(4):
//   (a) JSON success
//   (b) stream success
//   (c) stream mid-flight error per protocol (OpenAI / Anthropic / Responses
//       error shapes are produced by each strategy's adaptStreamError;
//       Runner just writes whatever it returns)
//   (d) upstream rejection
//   (e) finally log emission
// ---------------------------------------------------------------------------

import type { Context } from "hono"
import type { SSEMessage } from "hono/streaming"
import { streamSSE } from "hono/streaming"

import type { RequestContext } from "./context"
import type { DispatchResult, Strategy } from "./strategy"
import { computeStreamTimings } from "./stream-runner"
import { extractErrorDetails, normalizeRequestError, RequestCancelledError } from "../lib/error"
import { logEmitter } from "../util/log-emitter"
import { routingLog } from "./routing-log"
import { logRequestError } from "./request-log"

export async function execute<Req, UpReq, UpResp, Resp, Ch, Ev extends SSEMessage, St>(
  c: Context,
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  payload: Req,
): Promise<Response> {
  const controller = new AbortController()
  ctx = {
    ...ctx,
    signal: AbortSignal.any([controller.signal, c.req.raw.signal, ...(ctx.signal ? [ctx.signal] : [])]),
  }
  let upstreamReq: UpReq
  try {
    upstreamReq = strategy.prepare(payload, ctx)
  } catch (error) {
    logRequestError(ctx, error, { strategy: strategy.name })
    throw error
  }

  let dispatched: DispatchResult<UpResp, Ch>
  try {
    throwIfAborted(ctx.signal!)
    dispatched = await strategy.dispatch(upstreamReq, ctx)
    if (dispatched.kind === "json") throwIfAborted(ctx.signal!)
  } catch (err) {
    const error = normalizeRequestError(err, ctx.signal)
    emitErrorEnd(ctx, strategy, upstreamReq, error, { stream: ctx.stream })
    throw error
  }

  if (dispatched.kind === "json") {
    let clientResp: Resp
    try {
      clientResp = strategy.adaptJson(dispatched.body, upstreamReq, ctx)
    } catch (err) {
      // adaptJson is pure but can throw on protocol-shape failures (e.g. naked
      // JSON.parse on a tool-call argument). Without this guard we would
      // return 500 from Hono's default handler and never emit request_end —
      // breaking the db/request-sink "every request emits one request_end"
      // contract. Re-throw so the route-level forwardError still runs.
      emitErrorEnd(ctx, strategy, upstreamReq, err, { stream: ctx.stream })
      throw err
    }
    emitSuccessEnd(ctx, strategy, upstreamReq, dispatched.body)
    return c.json(clientResp as Record<string, unknown>)
  }

  return runStream(c, ctx, strategy, upstreamReq, dispatched.chunks, controller)
}

function runStream<Req, UpReq, UpResp, Resp, Ch, Ev extends SSEMessage, St>(
  c: Context,
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  upstreamReq: UpReq,
  chunks: AsyncIterable<Ch>,
  controller: AbortController,
): Response {
  const state = strategy.initStreamState(upstreamReq, ctx)
  let firstChunkTime: number | null = null
  let streamError: unknown | null = null
  let completed = false

  return streamSSE(c, async (sseStream) => {
    const signal = ctx.signal!
    sseStream.onAbort(() => controller.abort())
    const onAbort = () => sseStream.abort()
    signal.addEventListener("abort", onAbort, { once: true })
    const writeEvents = async (events: Ev[], terminal = false) => {
      throwIfAborted(signal)
      for (const ev of events) {
        throwIfAborted(signal)
        await sseStream.writeSSE(sanitizeSSEMessage(ev))
        throwIfAborted(signal)
      }
      if (terminal) completed = true
    }
    const finalEvents = () => strategy.streamOutcome?.(state) === "error"
      ? [] : strategy.finalizeStream?.(state, ctx) ?? []
    try {
      if (signal.aborted) onAbort()
      for await (const upstreamChunk of chunks) {
        throwIfAborted(signal)
        if (firstChunkTime === null) firstChunkTime = performance.now()
        const events = strategy.adaptChunk(upstreamChunk, state, ctx)
        const terminal = strategy.isStreamTerminal?.(upstreamChunk, state) ?? false
        await writeEvents(terminal ? [...events, ...finalEvents()] : events, terminal)
        if (completed) break
      }
      if (!completed) await writeEvents(finalEvents(), true)
    } catch (err) {
      if (completed) return
      streamError = normalizeRequestError(err, signal)
      if (signal.aborted || strategy.streamOutcome?.(state) === "error") return
      const terminal = strategy.adaptStreamError(err, state, ctx)
      for (const ev of terminal) {
        try {
          if (signal.aborted) break
          await sseStream.writeSSE(sanitizeSSEMessage(ev))
        } catch {
          // Best-effort — connection may already be closed.
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort)
      emitStreamEnd(ctx, strategy, upstreamReq, state, firstChunkTime, streamError)
    }
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The request was aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

// Since hono 4.12.31, writeSSE emits `retry: null` literally when retry is
// null (previously null was filtered by a truthy check). Our internal SSE
// event type carries `retry: number | null` / `event: string | null` /
// `id: string | null`; drop the null fields so on-wire output matches the
// SSE spec (only present fields).
function sanitizeSSEMessage<Ev extends SSEMessage>(ev: Ev): SSEMessage {
  const out: SSEMessage = { data: ev.data }
  if (ev.event != null) out.event = ev.event
  if (ev.id != null) out.id = ev.id
  if (ev.retry != null) out.retry = ev.retry
  return out
}

function emitSuccessEnd<Req, UpReq, UpResp, Resp, Ch, Ev extends SSEMessage, St>(
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  req: UpReq,
  resp: UpResp,
): void {
  const latencyMs = Math.round(performance.now() - ctx.startTime)
  const extras = strategy.describeEndLog({ kind: "json", req, resp }, ctx)
  logEmitter.emitLog({
    ts: Date.now(),
    level: "info",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `200 ${ctx.format} ${latencyMs}ms`,
    data: {
      path: ctx.path,
      format: ctx.format,
      stream: false,
      status: "success",
      statusCode: 200,
      upstreamStatus: 200,
      latencyMs,
      ttftMs: null,
      processingMs: null,
      strategy: strategy.name,
      accountName: ctx.accountName,
      apiKeyId: ctx.keyId, clientIP: ctx.clientIP ?? null, peerIP: ctx.peerIP ?? null, ipSource: ctx.ipSource ?? null,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
      ...extras,
      ...routingLog(ctx),
    },
  })
}

function emitStreamEnd<Req, UpReq, UpResp, Resp, Ch, Ev extends SSEMessage, St>(
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  req: UpReq,
  state: St,
  firstChunkTime: number | null,
  err: unknown | null,
): void {
  const { latencyMs, ttftMs, processingMs } = computeStreamTimings(
    ctx.startTime,
    firstChunkTime,
  )
  const extras = strategy.describeEndLog({ kind: "stream", req, state }, ctx)
  const inlineFailed = strategy.streamOutcome?.(state) === "error"
  const cancelled = !inlineFailed && err instanceof RequestCancelledError
  const failed = inlineFailed || (!!err && !cancelled)
  const errorDetail = inlineFailed ? "upstream stream error event" : err
    ? err instanceof Error
      ? cancelled ? err.message : `stream error: ${err.message}`
      : "stream error"
    : null

  logEmitter.emitLog({
    ts: Date.now(),
    level: failed ? "error" : "info",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `${failed ? "error" : cancelled ? "cancelled" : "200"} ${ctx.format} ${latencyMs}ms`,
    data: {
      path: ctx.path,
      format: ctx.format,
      stream: true,
      status: failed ? "error" : cancelled ? "cancelled" : "success",
      statusCode: 200,
      upstreamStatus: 200,
      latencyMs,
      ttftMs,
      processingMs,
      strategy: strategy.name,
      accountName: ctx.accountName,
      apiKeyId: ctx.keyId, clientIP: ctx.clientIP ?? null, peerIP: ctx.peerIP ?? null, ipSource: ctx.ipSource ?? null,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
      ...extras,
      ...routingLog(ctx),
      ...(errorDetail !== null && { error: errorDetail }),
    },
  })
}

function emitErrorEnd<Req, UpReq, UpResp, Resp, Ch, Ev extends SSEMessage, St>(
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  req: UpReq,
  err: unknown,
  opts: { stream: boolean },
): void {
  const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(err)
  const cancelled = err instanceof RequestCancelledError
  const latencyMs = Math.round(performance.now() - ctx.startTime)
  const extras = strategy.describeEndLog({ kind: "error", req, err }, ctx)
  logEmitter.emitLog({
    ts: Date.now(),
    level: cancelled ? "info" : "error",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `${statusCode} ${ctx.format} ${latencyMs}ms`,
    data: {
      path: ctx.path,
      format: ctx.format,
      stream: opts.stream,
      status: cancelled ? "cancelled" : "error",
      statusCode,
      upstreamStatus,
      latencyMs,
      ttftMs: null,
      processingMs: null,
      error: errorDetail,
      strategy: strategy.name,
      accountName: ctx.accountName,
      apiKeyId: ctx.keyId, clientIP: ctx.clientIP ?? null, peerIP: ctx.peerIP ?? null, ipSource: ctx.ipSource ?? null,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
      ...extras,
      ...routingLog(ctx),
    },
  })
}
