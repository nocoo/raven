import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import { logEmitter } from "~/util/log-emitter"
import { generateRequestId } from "~/util/id"
import { deriveClientIdentity } from "~/util/client-identity"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateRequestId()

  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  const model = payload.model
  const stream = !!payload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent")
  const openaiUser = payload.user ?? undefined
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(undefined, userAgent, accountName, openaiUser)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/chat/completions ${model}`,
    data: { path: "/v1/chat/completions", format: "openai", model, stream, accountName, sessionId, clientName, clientVersion },
  })

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (m) => m.id === payload.model,
  )

  // Calculate token count (best-effort)
  try {
    if (selectedModel) {
      await getTokenCount(payload, selectedModel)
    }
  } catch {
    // Token count failure is non-fatal
  }

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
  }

  try {
    const response = await createChatCompletions(payload)

    if (isNonStreaming(response)) {
      const latencyMs = Math.round(performance.now() - startTime)
      const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (response.usage?.prompt_tokens ?? 0) - cachedTokens
      const outputTokens = response.usage?.completion_tokens ?? 0

      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `200 ${model} ${latencyMs}ms`,
        data: {
          path: "/v1/chat/completions", format: "openai", model,
          resolvedModel: response.model, inputTokens, outputTokens,
          latencyMs, ttftMs: null, processingMs: null,
          stream: false, status: "success", statusCode: 200,
          upstreamStatus: 200, accountName, sessionId, clientName, clientVersion,
        },
      })

      return c.json(response)
    }

    // Streaming
    let resolvedModel = model
    let inputTokens = 0
    let outputTokens = 0
    let streamError: string | null = null
    let firstChunkTime: number | null = null

    return streamSSE(c, async (sseStream) => {
      try {
        for await (const chunk of response) {
          if (firstChunkTime === null) firstChunkTime = performance.now()

          await sseStream.writeSSE(chunk as SSEMessage)

          // Extract metrics from chunk data
          if (chunk.data && chunk.data !== "[DONE]") {
            try {
              const parsed = JSON.parse(chunk.data)
              if (parsed.model) resolvedModel = parsed.model
              if (parsed.usage) {
                const cached = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
                inputTokens = (parsed.usage.prompt_tokens ?? 0) - cached
                outputTokens = parsed.usage.completion_tokens ?? 0
              }
            } catch {
              // Parse error for metrics — don't break stream
            }
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? `stream error: ${err.message}` : "stream error"

        // Send an error chunk so the client knows the stream failed
        try {
          await sseStream.writeSSE({
            data: JSON.stringify({
              error: {
                message: "An upstream error occurred during streaming.",
                type: "server_error",
                code: "stream_error",
              },
            }),
          })
        } catch {
          // Best-effort — connection may already be closed
        }
      } finally {
        const endTime = performance.now()
        const latencyMs = Math.round(endTime - startTime)
        const ttftMs = firstChunkTime !== null ? Math.round(firstChunkTime - startTime) : null
        const processingMs = firstChunkTime !== null ? Math.round(endTime - firstChunkTime) : null
        logEmitter.emitLog({
          ts: Date.now(), level: streamError ? "error" : "info",
          type: "request_end", requestId,
          msg: `${streamError ? "error" : "200"} ${model} ${latencyMs}ms`,
          data: {
            path: "/v1/chat/completions", format: "openai", model,
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
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const statusCode = 502
    const errorMsg = error instanceof Error ? error.message : String(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "upstream_error", requestId,
      msg: `upstream error for ${model}`,
      data: { error: errorMsg, latencyMs },
    })
    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/chat/completions", format: "openai", model, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus: null, error: errorMsg, accountName,
        sessionId, clientName, clientVersion,
      },
    })
    throw error
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
