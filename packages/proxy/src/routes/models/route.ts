import { Hono } from "hono"
import { projectCatalog } from "../../db/catalog"
import { buildContext } from "../../core/context"
import { extractErrorDetails, forwardError } from "../../lib/error"
import { logEmitter } from "../../util/log-emitter"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  const ctx = buildContext(c, "openai")
  const data = {
    path: ctx.path, format: ctx.format, model: "models", stream: false,
    accountName: ctx.accountName, apiKeyId: ctx.keyId, clientIP: ctx.clientIP ?? null, peerIP: ctx.peerIP ?? null, ipSource: ctx.ipSource ?? null, sessionId: ctx.sessionId,
    clientName: ctx.clientName, clientVersion: ctx.clientVersion,
  }
  logEmitter.emitLog({ ts: Date.now(), level: "info", type: "request_start", requestId: ctx.requestId, msg: "GET /v1/models", data })
  try {
    const models = projectCatalog(c.get("routingDb"))
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId: ctx.requestId,
      msg: "200 models", data: { ...data, modelCount: models.length, status: "success", statusCode: 200, latencyMs: Math.round(performance.now() - ctx.startTime), ttftMs: null, processingMs: null },
    })
    return c.json({ object: "list", data: models, has_more: false })
  } catch (error) {
    const { errorDetail, statusCode, upstreamStatus } = extractErrorDetails(error)
    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId: ctx.requestId,
      msg: `${statusCode} models`, data: { ...data, status: "error", statusCode, upstreamStatus, error: errorDetail, latencyMs: Math.round(performance.now() - ctx.startTime) },
    })
    return forwardError(c, error)
  }
})
