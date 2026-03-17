import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { logEmitter } from "~/util/log-emitter"
import { generateRequestId } from "~/util/id"
import { deriveClientIdentity } from "~/util/client-identity"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateRequestId()

  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const model = anthropicPayload.model
  const stream = !!anthropicPayload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent")
  const userId = anthropicPayload.metadata?.user_id
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(userId, userAgent, accountName)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/messages ${model}`,
    data: {
      path: "/v1/messages", format: "anthropic", model, stream,
      messageCount: anthropicPayload.messages?.length ?? 0,
      toolCount: anthropicPayload.tools?.length ?? 0,
      accountName, sessionId, clientName, clientVersion,
    },
  })

  const openAIPayload = translateToOpenAI(anthropicPayload)

  try {
    const response = await createChatCompletions(openAIPayload)

    if (isNonStreaming(response)) {
      const anthropicResponse = translateToAnthropic(response)
      const latencyMs = Math.round(performance.now() - startTime)
      const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (response.usage?.prompt_tokens ?? 0) - cachedTokens
      const outputTokens = response.usage?.completion_tokens ?? 0

      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `200 ${model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages", format: "anthropic", model,
          resolvedModel: response.model,
          translatedModel: openAIPayload.model,
          inputTokens, outputTokens, latencyMs,
          ttftMs: latencyMs, processingMs: 0,
          stream: false, status: "success", statusCode: 200,
          upstreamStatus: 200, accountName, sessionId, clientName, clientVersion,
        },
      })

      return c.json(anthropicResponse)
    }

    // Streaming
    let resolvedModel = model
    let inputTokens = 0
    let outputTokens = 0
    let streamError: string | null = null
    let firstChunkTime: number | null = null

    return streamSSE(c, async (sseStream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      }

      try {
        for await (const rawEvent of response) {
          if (rawEvent.data === "[DONE]") break
          if (!rawEvent.data) continue

          if (firstChunkTime === null) firstChunkTime = performance.now()

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

          // Extract metrics
          if (chunk.model) resolvedModel = chunk.model
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
            inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached
            outputTokens = chunk.usage.completion_tokens ?? 0
          }

          const events = translateChunkToAnthropicEvents(chunk, streamState)

          for (const event of events) {
            await sseStream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? `stream error: ${err.message}` : "stream error"

        // Send Anthropic error event so the client knows the stream failed
        try {
          const errorEvent = translateErrorToAnthropicErrorEvent()
          await sseStream.writeSSE({
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
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
            path: "/v1/messages", format: "anthropic", model,
            resolvedModel, translatedModel: openAIPayload.model,
            inputTokens, outputTokens, latencyMs, ttftMs, processingMs,
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
    const errorMsg = error instanceof Error ? error.message : String(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "upstream_error", requestId,
      msg: `upstream error for ${model}`,
      data: { error: errorMsg, latencyMs },
    })
    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `502 ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model, stream,
        latencyMs, status: "error", statusCode: 502,
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
