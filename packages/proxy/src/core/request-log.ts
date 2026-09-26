import type { RequestContext } from "./context"
import { routingLog } from "./routing-log"
import { extractErrorDetails } from "../lib/error"
import { logEmitter } from "../util/log-emitter"

export function requestIdentity(ctx: RequestContext): Record<string, unknown> {
  return {
    path: ctx.path,
    format: ctx.format,
    stream: ctx.stream,
    accountName: ctx.accountName,
    apiKeyId: ctx.keyId, clientIP: ctx.clientIP ?? null, peerIP: ctx.peerIP ?? null, ipSource: ctx.ipSource ?? null,
    sessionId: ctx.sessionId,
    clientName: ctx.clientName,
    clientVersion: ctx.clientVersion,
  }
}

export function logRequestStart(ctx: RequestContext, model: string, extras: Record<string, unknown> = {}): void {
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId: ctx.requestId,
    msg: `POST ${ctx.path} ${model}`,
    data: { ...requestIdentity(ctx), model, ...extras },
  })
}

export function logRequestError(ctx: RequestContext, error: unknown, extras: Record<string, unknown> = {}): void {
  const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)
  logEmitter.emitLog({
    ts: Date.now(), level: "error", type: "request_end", requestId: ctx.requestId,
    msg: `${statusCode} ${ctx.format}`,
    data: {
      ...requestIdentity(ctx), ...extras, ...routingLog(ctx),
      status: "error", statusCode, upstreamStatus, error: errorDetail,
      latencyMs: Math.round(performance.now() - ctx.startTime), ttftMs: null, processingMs: null,
    },
  })
}
