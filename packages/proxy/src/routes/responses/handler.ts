import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { buildUpstreamClient } from "../../composition/upstream-registry"
import type { ResponsesPayload } from "../../upstream/copilot-responses"
import { extractErrorDetails, forwardError } from "../../lib/error"
import { checkRateLimit } from "../../lib/rate-limit"
import { state } from "../../lib/state"
import type { ServerSentEvent } from "../../util/sse"
import { logEmitter } from "../../util/log-emitter"
import { emitUpstreamRawSse } from "../../util/emit-upstream-raw"
// Phase F.1 — temporary; removed in F.3
import { emitRouterTrace } from "../../lib/router-trace"
import { generateRequestId } from "../../util/id"
import { deriveClientIdentity } from "../../util/client-identity"
import {
  extractNonStreamingMeta,
  extractResolvedModel,
  extractUsage,
  isTerminalResponseEvent,
} from "../../protocols/responses/stream-state"

export const handleResponses = async (c: Context) => {
  const startTime = performance.now()
  const requestId = generateRequestId()

  let payload: ResponsesPayload

  try {
    await checkRateLimit(state)
  } catch (error) {
    // Rate limit error — forward with proper status
    return forwardError(c, error)
  }

  try {
    payload = await c.req.json<ResponsesPayload>()
  } catch {
    return c.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, 400)
  }

  const model = payload.model
  const stream = !!payload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(null, userAgent, accountName, null)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/responses ${model}`,
    data: { path: "/v1/responses", format: "responses", model, stream, accountName, sessionId, clientName, clientVersion },
  })

  emitRouterTrace({
    requestId, protocol: "responses", model,
    decision: { kind: "ok", name: "copilot-responses" },
  })

  try {
    const response = await buildUpstreamClient("copilot-responses").send(payload)

    // Streaming: passthrough SSE events
    if (stream && isAsyncIterable(response)) {
      let resolvedModel = model
      let inputTokens = 0
      let outputTokens = 0
      let streamError: string | null = null
      let firstChunkTime: number | null = null

      return streamSSE(c, async (sseStream) => {
        try {
          for await (const chunk of response as AsyncIterable<ServerSentEvent>) {
            emitUpstreamRawSse(requestId, { event: chunk.event, data: chunk.data })
            if (firstChunkTime === null) firstChunkTime = performance.now()

            // Passthrough all SSE fields: event, data, id, retry
            const sseMsg: { data: string; event?: string; id?: string; retry?: number } = {
              data: chunk.data,
            }
            if (chunk.event) sseMsg.event = chunk.event
            if (chunk.id) sseMsg.id = chunk.id
            if (chunk.retry !== null) sseMsg.retry = chunk.retry

            await sseStream.writeSSE(sseMsg)

            if (chunk.event === "response.created") {
              const model = extractResolvedModel(chunk.data)
              if (model) resolvedModel = model
            }

            if (isTerminalResponseEvent(chunk.event)) {
              const usage = extractUsage(chunk.data)
              if (usage) {
                inputTokens = usage.inputTokens
                outputTokens = usage.outputTokens
              }
            }
          }
        } catch (err) {
          streamError = err instanceof Error ? `stream error: ${err.message}` : "stream error"

          // Best-effort: send error event so client knows stream failed
          try {
            await sseStream.writeSSE({
              event: "error",
              data: JSON.stringify({
                error: {
                  type: "server_error",
                  code: "stream_error",
                  message: "An upstream error occurred during streaming.",
                },
              }),
            })
          } catch {
            // Connection may already be closed
          }
        } finally {
          const endTime = performance.now()
          const latencyMs = Math.round(endTime - startTime)
          const ttftMs = firstChunkTime !== null ? Math.round(firstChunkTime - startTime) : null
          const processingMs = firstChunkTime !== null ? Math.round(endTime - firstChunkTime) : null

          logEmitter.emitLog({
            ts: Date.now(), level: streamError ? "error" : "info",
            type: "request_end", requestId,
            msg: `${streamError ? "error" : "200"} ${resolvedModel} ${latencyMs}ms`,
            data: {
              path: "/v1/responses", format: "responses", model,
              resolvedModel, inputTokens, outputTokens, latencyMs,
              ttftMs, processingMs,
              stream: true, status: streamError ? "error" : "success",
              statusCode: streamError ? 502 : 200,
              upstreamStatus: streamError ? null : 200,
              accountName, sessionId, clientName, clientVersion,
              ...(streamError && { error: streamError }),
            },
          })
        }
      })
    }

    // Non-streaming: return JSON
    const latencyMs = Math.round(performance.now() - startTime)
    const { resolvedModel, inputTokens, outputTokens } = extractNonStreamingMeta(response, model)

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId,
      msg: `200 ${resolvedModel} ${latencyMs}ms`,
      data: {
        path: "/v1/responses", format: "responses", model,
        resolvedModel, inputTokens, outputTokens, latencyMs,
        ttftMs: null, processingMs: null,
        stream: false, status: "success", statusCode: 200,
        upstreamStatus: 200, accountName, sessionId, clientName, clientVersion,
      },
    })

    return c.json(response)
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/responses", format: "responses", model, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorDetail, accountName,
        sessionId, clientName, clientVersion,
      },
    })
    return forwardError(c, error)
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}
