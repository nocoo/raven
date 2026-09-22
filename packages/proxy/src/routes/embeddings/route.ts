import { Hono } from "hono"
import { dispatchEmbedding } from "../../composition/embeddings"
import { buildContext } from "../../core/context"
import { logRequestError, logRequestStart, requestIdentity } from "../../core/request-log"
import { routingLog } from "../../core/routing-log"
import { ClientInputError, forwardError } from "../../lib/error"
import { logEmitter } from "../../util/log-emitter"
import type { EmbeddingRequest } from "../../upstream/copilot-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  const ctx = buildContext(c, "openai")
  try {
    let payload: EmbeddingRequest
    try { payload = await c.req.json<EmbeddingRequest>() }
    catch { throw new ClientInputError("Invalid JSON") }
    if (!payload || typeof payload.model !== "string" || !payload.model.trim()) throw new ClientInputError("A model is required")
    logRequestStart(ctx, payload.model)
    const response = await dispatchEmbedding(c, ctx, payload)
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId: ctx.requestId,
      msg: "200 embeddings",
      data: {
        ...requestIdentity(ctx), ...routingLog(ctx),
        latencyMs: Math.round(performance.now() - ctx.startTime),
        status: "success", statusCode: 200, upstreamStatus: 200,
      },
    })
    return c.json(response)
  } catch (error) {
    logRequestError(ctx, error)
    return forwardError(c, error)
  }
})
