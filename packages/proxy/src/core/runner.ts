// ---------------------------------------------------------------------------
// core/runner.ts (G.5) — generic executor for the symmetric pipeline (§3.5).
//
// G.3 landed the JSON path + skeleton; G.5 adds the streaming path. Coverage
// paths per §4.5(4):
//   (a) JSON success           ← G.3
//   (d) upstream rejection     ← G.3
//   (e) finally log emission   ← G.3 (json) + G.5 (stream)
//   (b) stream success         ← G.5
//   (c) stream mid-flight error per protocol  ← G.5 (OpenAI / Anthropic /
//       Responses error shapes are produced by each strategy's
//       adaptStreamError; Runner just writes whatever it returns)
// ---------------------------------------------------------------------------

import type { Context } from "hono"
import type { SSEMessage } from "hono/streaming"
import { streamSSE } from "hono/streaming"

import type { RequestContext } from "./context"
import type { DispatchResult, Strategy } from "./strategy"
import { computeStreamTimings } from "./stream-runner"
import { extractErrorDetails } from "../lib/error"
import { logEmitter } from "../util/log-emitter"

export async function execute<Req, UpReq, UpResp, Resp, Ch, Ev extends SSEMessage, St>(
  c: Context,
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  payload: Req,
): Promise<Response> {
  const upstreamReq = strategy.prepare(payload, ctx)

  let dispatched: DispatchResult<UpResp, Ch>
  try {
    dispatched = await strategy.dispatch(upstreamReq, ctx)
  } catch (err) {
    emitErrorEnd(ctx, strategy, upstreamReq, err, { stream: false })
    throw err
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
      emitErrorEnd(ctx, strategy, upstreamReq, err, { stream: false })
      throw err
    }
    emitSuccessEnd(ctx, strategy, upstreamReq, dispatched.body)
    return c.json(clientResp as Record<string, unknown>)
  }

  return runStream(c, ctx, strategy, upstreamReq, dispatched.chunks)
}

function runStream<Req, UpReq, UpResp, Resp, Ch, Ev extends SSEMessage, St>(
  c: Context,
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  upstreamReq: UpReq,
  chunks: AsyncIterable<Ch>,
): Response {
  const state = strategy.initStreamState(upstreamReq, ctx)
  let firstChunkTime: number | null = null
  let streamError: unknown | null = null

  return streamSSE(c, async (sseStream) => {
    try {
      for await (const upstreamChunk of chunks) {
        if (firstChunkTime === null) firstChunkTime = performance.now()
        const events = strategy.adaptChunk(upstreamChunk, state, ctx)
        for (const ev of events) {
          await sseStream.writeSSE(ev)
        }
      }
    } catch (err) {
      streamError = err
      const terminal = strategy.adaptStreamError(err, state, ctx)
      for (const ev of terminal) {
        try {
          await sseStream.writeSSE(ev)
        } catch {
          // Best-effort — connection may already be closed.
        }
      }
    } finally {
      emitStreamEnd(ctx, strategy, upstreamReq, state, firstChunkTime, streamError)
    }
  })
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
      accountName: ctx.accountName,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
      ...extras,
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
  const errorDetail = err
    ? err instanceof Error
      ? `stream error: ${err.message}`
      : "stream error"
    : null

  logEmitter.emitLog({
    ts: Date.now(),
    level: err ? "error" : "info",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `${err ? "error" : "200"} ${ctx.format} ${latencyMs}ms`,
    data: {
      path: ctx.path,
      format: ctx.format,
      stream: true,
      status: err ? "error" : "success",
      statusCode: err ? 502 : 200,
      upstreamStatus: err ? null : 200,
      latencyMs,
      ttftMs,
      processingMs,
      accountName: ctx.accountName,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
      ...extras,
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
  const latencyMs = Math.round(performance.now() - ctx.startTime)
  const extras = strategy.describeEndLog({ kind: "error", req, err }, ctx)
  logEmitter.emitLog({
    ts: Date.now(),
    level: "error",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `${statusCode} ${ctx.format} ${latencyMs}ms`,
    data: {
      path: ctx.path,
      format: ctx.format,
      stream: opts.stream,
      status: "error",
      statusCode,
      upstreamStatus,
      latencyMs,
      ttftMs: null,
      processingMs: null,
      error: errorDetail,
      accountName: ctx.accountName,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
      ...extras,
    },
  })
}
