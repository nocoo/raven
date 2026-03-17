import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { logEmitter } from "~/util/log-emitter"
import { generateRequestId } from "~/util/id"
import { deriveClientIdentity } from "~/util/client-identity"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  const startTime = performance.now()
  const requestId = generateRequestId()
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent")
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(undefined, userAgent, accountName)

  try {
    const payload = await c.req.json<EmbeddingRequest>()
    const model = payload.model

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_start", requestId,
      msg: `POST /v1/embeddings ${model}`,
      data: { path: "/v1/embeddings", format: "openai", model, stream: false, accountName, sessionId, clientName, clientVersion },
    })

    const response = await createEmbeddings(payload)
    const latencyMs = Math.round(performance.now() - startTime)

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId,
      msg: `200 ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/embeddings", format: "openai", model, latencyMs,
        stream: false, status: "success", statusCode: 200,
        upstreamStatus: 200, accountName, sessionId, clientName, clientVersion,
      },
    })

    return c.json(response)
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const errorMsg = error instanceof Error ? error.message : String(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `502 embeddings ${latencyMs}ms`,
      data: {
        path: "/v1/embeddings", format: "openai", latencyMs,
        stream: false, status: "error", statusCode: 502,
        upstreamStatus: null, error: errorMsg, accountName,
        sessionId, clientName, clientVersion,
      },
    })

    return await forwardError(c, error)
  }
})
