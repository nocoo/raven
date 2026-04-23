// Central error mapper for router reject decisions.
//
// All three handlers (chat-completions, messages, responses) need to
// convert StrategyDecision.reject into an HTTP response + a uniform
// request_end log line. Keeping that wiring in one place avoids
// drift in the wire-error shape and the log field bag.

import type { Context } from "hono"
import type { StrategyDecision } from "./router"
import { logEmitter } from "../util/log-emitter"

export interface RejectLogContext {
  requestId: string
  startTime: number
  path: string
  format: "anthropic" | "openai" | "responses"
  model: string
  stream: boolean
  accountName: string
  sessionId: string
  clientName: string | null
  clientVersion: string | null
  /** Optional upstream tag for cases where the reject is provider-aware. */
  upstream?: string
  upstreamFormat?: "openai" | "anthropic"
}

export function respondRouterReject(
  c: Context,
  reject: Extract<StrategyDecision, { kind: "reject" }>,
  ctx: RejectLogContext,
) {
  const latencyMs = Math.round(performance.now() - ctx.startTime)

  logEmitter.emitLog({
    ts: Date.now(),
    level: "error",
    type: "request_end",
    requestId: ctx.requestId,
    msg: `${reject.status} ${ctx.model} ${latencyMs}ms`,
    data: {
      path: ctx.path,
      format: ctx.format,
      model: ctx.model,
      stream: ctx.stream,
      latencyMs,
      status: "error",
      statusCode: reject.status,
      upstreamStatus: null,
      error: reject.message,
      ...(ctx.upstream ? { upstream: ctx.upstream } : {}),
      ...(ctx.upstreamFormat ? { upstreamFormat: ctx.upstreamFormat } : {}),
      accountName: ctx.accountName,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
    },
  })

  return c.json(
    { error: { message: reject.message, type: reject.errorType } },
    reject.status as 400,
  )
}
