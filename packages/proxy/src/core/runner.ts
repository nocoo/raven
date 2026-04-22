// ---------------------------------------------------------------------------
// core/runner.ts (G.3) — generic executor for the symmetric pipeline (§3.5).
//
// G.3 lands the JSON path only. The streaming path returns a 500 placeholder
// until G.5; concrete strategies aren't ported until G.6+. Coverage paths
// per §4.5(4):
//   (a) JSON success           ← covered here
//   (d) upstream rejection     ← covered here (rethrow + request_end error)
//   (e) finally log emission   ← covered via the rejection test
// (b) stream success and (c) stream mid-flight error land in G.5.
// ---------------------------------------------------------------------------

import type { Context } from "hono"

import type { RequestContext } from "./context"
import type { DispatchResult, Strategy } from "./strategy"
import { extractErrorDetails } from "../lib/error"
import { logEmitter } from "../util/log-emitter"

export async function execute<Req, UpReq, UpResp, Resp, Ch, Ev, St>(
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
    emitErrorEnd(ctx, err)
    throw err
  }

  if (dispatched.kind === "json") {
    const clientResp = strategy.adaptJson(dispatched.body, ctx)
    emitSuccessEnd(ctx, strategy, dispatched.body)
    return c.json(clientResp as Record<string, unknown>)
  }

  // dispatched.kind === "stream" — wired in G.5.
  emitErrorEnd(ctx, new Error("runner streaming path not implemented (G.5)"))
  return c.json(
    { error: { type: "internal_error", message: "streaming not yet wired" } },
    500,
  )
}

function emitSuccessEnd<Req, UpReq, UpResp, Resp, Ch, Ev, St>(
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  resp: UpResp,
): void {
  const latencyMs = Math.round(performance.now() - ctx.startTime)
  const extras = strategy.describeEndLog({ kind: "json", resp }, ctx)
  logEmitter.emitLog({
    ts: Date.now(),
    level: "info",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `200 ${ctx.format} ${latencyMs}ms`,
    data: {
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

function emitErrorEnd(ctx: RequestContext, err: unknown): void {
  const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(err)
  const latencyMs = Math.round(performance.now() - ctx.startTime)
  logEmitter.emitLog({
    ts: Date.now(),
    level: "error",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `${statusCode} ${ctx.format} ${latencyMs}ms`,
    data: {
      format: ctx.format,
      stream: false,
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
    },
  })
}
