import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { checkRateLimit } from "./../../lib/rate-limit"
import { state } from "./../../lib/state"
import { resolveProvider } from "./../../lib/upstream-router"
import type { CompiledProvider } from "./../../db/providers"
import { isNullish } from "./../../lib/utils"
import { logEmitter } from "./../../util/log-emitter"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"
import { sendOpenAIDirect } from "./../../services/upstream/send-openai"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "./../../services/copilot/create-chat-completions"
import { extractErrorDetails, forwardError } from "./../../lib/error"

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateRequestId()

  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  const model = payload.model
  const stream = !!payload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const openaiUser = payload.user ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(null, userAgent, accountName, openaiUser)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/chat/completions ${model}`,
    data: { path: "/v1/chat/completions", format: "openai", model, stream, accountName, sessionId, clientName, clientVersion },
  })

  // Debug: log tool definitions
  if (state.optToolCallDebug && payload.tools) {
    logEmitter.emitLog({
      ts: Date.now(), level: "debug", type: "request_start", requestId,
      msg: `tool definitions: ${payload.tools.length}`,
      data: {
        toolDefinitions: payload.tools.map((t: { function: { name: string } }) => t.function.name),
        toolDefinitionCount: payload.tools.length,
      },
    })
  }

  // Check for custom upstream provider
  const resolved = resolveProvider(model)
  if (resolved) {
    const { provider } = resolved
    if (provider.format === "openai") {
      // Passthrough: forward OpenAI payload directly
      return handleOpenAIPassthrough(
        c,
        requestId,
        payload,
        startTime,
        provider,
        { accountName, sessionId, clientName, clientVersion },
      )
    }
    // Anthropic upstream: not supported in V1 (no reverse translation)
    const latencyMs = Math.round(performance.now() - startTime)
    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `400 ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/chat/completions", format: "openai", model, stream,
        latencyMs, status: "error", statusCode: 400,
        upstreamStatus: null,
        error: "OpenAI client → Anthropic upstream not supported",
        upstream: provider.name, upstreamFormat: provider.format,
        accountName, sessionId, clientName, clientVersion,
      },
    })
    return c.json(
      {
        error: {
          message: "OpenAI client requests cannot be routed to Anthropic-format upstreams. Use the Anthropic Messages API instead.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (m) => m.id === payload.model,
  )

  if (isNullish(payload.max_tokens)) {
    const maxOutputTokens = selectedModel?.capabilities.limits.max_output_tokens
    payload = {
      ...payload,
      max_tokens: maxOutputTokens ?? null,
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
    const toolCallIds = new Set<string>()

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

              // Debug: detect new tool calls
              if (state.optToolCallDebug && parsed.choices?.[0]?.delta?.tool_calls) {
                for (const tc of parsed.choices[0].delta.tool_calls) {
                  if (tc.id && tc.function?.name && !toolCallIds.has(tc.id)) {
                    toolCallIds.add(tc.id)
                    logEmitter.emitLog({
                      ts: Date.now(), level: "debug", type: "sse_chunk", requestId,
                      msg: `tool_call started: ${tc.function.name}`,
                      data: {
                        eventType: "tool_call_start",
                        toolName: tc.function.name,
                        toolId: tc.id,
                        index: tc.index,
                      },
                    })
                  }
                }
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

        const baseData = {
          path: "/v1/chat/completions", format: "openai", model,
          resolvedModel, inputTokens, outputTokens, latencyMs,
          ttftMs, processingMs,
          stream: true, status: streamError ? "error" : "success",
          statusCode: streamError ? 502 : 200,
          upstreamStatus: streamError ? null : 200,
          accountName, sessionId, clientName, clientVersion,
        }

        const debugData = state.optToolCallDebug && !streamError ? {
          stopReason: toolCallIds.size > 0 ? "tool_calls" : "stop",
          toolCallCount: toolCallIds.size,
          toolCallNames: Array.from(toolCallIds),
        } : {}

        logEmitter.emitLog({
          ts: Date.now(), level: streamError ? "error" : "info",
          type: "request_end", requestId,
          msg: `${streamError ? "error" : "200"} ${model} ${latencyMs}ms`,
          data: {
            ...baseData,
            ...debugData,
            ...(streamError && { error: streamError }),
          },
        })
      }
    })
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/chat/completions", format: "openai", model, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorDetail, accountName,
        sessionId, clientName, clientVersion,
      },
    })
    throw error
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

// ===========================================================================
// Custom upstream provider handlers
// ===========================================================================

interface RequestContext {
  accountName: string
  sessionId: string
  clientName: string | null
  clientVersion: string | null
}

/** Handle OpenAI-format upstream with passthrough (no translation) */
async function handleOpenAIPassthrough(
  c: Context,
  requestId: string,
  payload: ChatCompletionsPayload,
  startTime: number,
  provider: CompiledProvider,
  ctx: RequestContext,
) {
  const { accountName, sessionId, clientName, clientVersion } = ctx
  const model = payload.model
  const stream = !!payload.stream

  try {
    const response = await sendOpenAIDirect(provider, payload)

    if (isOpenAINonStreaming(response)) {
      const latencyMs = Math.round(performance.now() - startTime)
      const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (response.usage?.prompt_tokens ?? 0) - cachedTokens
      const outputTokens = response.usage?.completion_tokens ?? 0

      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `200 ${model} ${latencyMs}ms`,
        data: {
          path: "/v1/chat/completions", format: "openai", model,
          resolvedModel: response.model, inputTokens, outputTokens, latencyMs,
          ttftMs: null, processingMs: null,
          stream: false, status: "success", statusCode: 200,
          upstreamStatus: 200, upstream: provider.name, upstreamFormat: provider.format,
          accountName, sessionId, clientName, clientVersion,
        },
      })

      return c.json(response)
    }

    // Streaming: passthrough SSE events directly
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
          // Connection may be closed
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
            upstream: provider.name, upstreamFormat: provider.format,
            accountName, sessionId, clientName, clientVersion,
            ...(streamError && { error: streamError }),
          },
        })
      }
    })
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/chat/completions", format: "openai", model, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorDetail,
        upstream: provider.name, upstreamFormat: provider.format,
        accountName, sessionId, clientName, clientVersion,
      },
    })
    return forwardError(c, error)
  }
}

/** Type guard for OpenAI non-streaming response */
function isOpenAINonStreaming(
  response: Awaited<ReturnType<typeof sendOpenAIDirect>>,
): response is ChatCompletionResponse {
  return typeof response === "object" && "object" in response && response.object === "chat.completion"
}
