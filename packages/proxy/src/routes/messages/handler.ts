import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { checkRateLimit } from "./../../lib/rate-limit"
import { state } from "./../../lib/state"
import { resolveProvider } from "./../../lib/upstream-router"
import type { ProviderRecord } from "./../../db/providers"
import { logEmitter } from "./../../util/log-emitter"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"
import { sendAnthropicDirect } from "./../../services/upstream/send-anthropic"
import { sendOpenAIDirect } from "./../../services/upstream/send-openai"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "./../../services/copilot/create-chat-completions"
import { forwardError, HTTPError } from "./../../lib/error"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
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
  const userAgent = c.req.header("user-agent") ?? null
  const userId = anthropicPayload.metadata?.user_id ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(userId, userAgent, accountName, null)

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

  // Debug: log tool definitions
  if (state.optToolCallDebug && anthropicPayload.tools) {
    logEmitter.emitLog({
      ts: Date.now(), level: "debug", type: "request_start", requestId,
      msg: `tool definitions: ${anthropicPayload.tools.length}`,
      data: {
        toolDefinitions: anthropicPayload.tools.map((t: { name: string }) => t.name),
        toolDefinitionCount: anthropicPayload.tools.length,
      },
    })
  }

  // Check for custom upstream provider
  const resolved = resolveProvider(model)
  if (resolved) {
    const { provider } = resolved
    if (provider.format === "anthropic") {
      // Passthrough: forward Anthropic payload directly
      return handleAnthropicPassthrough(
        c,
        requestId,
        anthropicPayload,
        startTime,
        provider,
        { accountName, sessionId, clientName, clientVersion },
      )
    }
    // OpenAI provider: translate then forward
    const openAIPayload = translateToOpenAI(anthropicPayload)
    return handleOpenAIUpstream(
      c,
      requestId,
      openAIPayload,
      startTime,
      provider,
      { accountName, sessionId, clientName, clientVersion },
      model,
    )
  }

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
          ttftMs: null, processingMs: null,
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
    let lastToolCallCount = 0

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

          // Debug: detect new tool calls
          if (state.optToolCallDebug) {
            const currentToolCallCount = Object.keys(streamState.toolCalls).length
            if (currentToolCallCount > lastToolCallCount) {
              // Find the new tool call (by highest block index)
              const newToolCall = Object.values(streamState.toolCalls).reduce((newest, tc) =>
                tc.anthropicBlockIndex > newest.anthropicBlockIndex ? tc : newest,
                { id: "", name: "", anthropicBlockIndex: -1 },
              )
              if (newToolCall.id) {
                logEmitter.emitLog({
                  ts: Date.now(), level: "debug", type: "sse_chunk", requestId,
                  msg: `tool_use started: ${newToolCall.name}`,
                  data: {
                    eventType: "tool_use_start",
                    toolName: newToolCall.name,
                    toolId: newToolCall.id,
                    blockIndex: newToolCall.anthropicBlockIndex,
                  },
                })
              }
            }
            lastToolCallCount = currentToolCallCount
          }

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

        // Build base request_end data
        const baseData = {
          path: "/v1/messages", format: "anthropic", model,
          resolvedModel, translatedModel: openAIPayload.model,
          inputTokens, outputTokens, latencyMs, ttftMs, processingMs,
          stream: true, status: streamError ? "error" : "success",
          statusCode: streamError ? 502 : 200,
          upstreamStatus: streamError ? null : 200,
          accountName, sessionId, clientName, clientVersion,
        }

        // Add debug info if enabled
        const debugData = state.optToolCallDebug && !streamError ? {
          stopReason: "tool_use", // Will be derived from stream state if tools were called
          toolCallCount: Object.keys(streamState.toolCalls).length,
          toolCallNames: Object.values(streamState.toolCalls).map(tc => tc.name),
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
    const errorMsg = error instanceof Error ? error.message : String(error)

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

// ===========================================================================
// Custom upstream provider handlers
// ===========================================================================

interface RequestContext {
  accountName: string
  sessionId: string
  clientName: string | null
  clientVersion: string | null
}

/** Handle Anthropic-format upstream with passthrough (no translation) */
async function handleAnthropicPassthrough(
  c: Context,
  requestId: string,
  payload: AnthropicMessagesPayload,
  startTime: number,
  provider: ProviderRecord,
  ctx: RequestContext,
) {
  const { accountName, sessionId, clientName, clientVersion } = ctx
  const model = payload.model
  const stream = !!payload.stream

  try {
    const response = await sendAnthropicDirect(provider, payload)

    if (isAnthropicNonStreaming(response)) {
      const latencyMs = Math.round(performance.now() - startTime)
      const inputTokens = response.usage?.input_tokens ?? 0
      const outputTokens = response.usage?.output_tokens ?? 0

      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `200 ${model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages", format: "anthropic", model, resolvedModel: model,
          inputTokens, outputTokens, latencyMs, ttftMs: null, processingMs: null,
          stream: false, status: "success", statusCode: 200,
          upstreamStatus: 200, upstream: provider.name, upstreamFormat: provider.format,
          accountName, sessionId, clientName, clientVersion,
        },
      })

      return c.json(response)
    }

    // Streaming: passthrough SSE events directly
    let inputTokens = 0
    let outputTokens = 0
    let streamError: string | null = null
    let firstChunkTime: number | null = null

    return streamSSE(c, async (sseStream) => {
      try {
        for await (const sseEvent of response) {
          if (firstChunkTime === null) firstChunkTime = performance.now()

          // Extract token usage from message_delta event
          try {
            const parsed = JSON.parse(sseEvent.data)
            if (parsed.type === "message_delta" && parsed.usage) {
              inputTokens = parsed.usage.input_tokens ?? 0
              outputTokens = parsed.usage.output_tokens ?? 0
            }
          } catch {
            // Ignore parse errors for metrics
          }

          if (sseEvent.event) {
            await sseStream.writeSSE({
              event: sseEvent.event,
              data: sseEvent.data,
            })
          } else {
            await sseStream.writeSSE({
              data: sseEvent.data,
            })
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? `stream error: ${err.message}` : "stream error"
        // Send Anthropic error event
        try {
          const errorEvent = translateErrorToAnthropicErrorEvent()
          await sseStream.writeSSE({
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
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
            path: "/v1/messages", format: "anthropic", model,
            inputTokens, outputTokens, latencyMs, ttftMs, processingMs,
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
    const errorMsg = error instanceof Error ? error.message : String(error)
    // Extract upstream status from HTTPError for accurate logging
    const upstreamStatus = error instanceof HTTPError ? error.response.status : null
    const statusCode = upstreamStatus ?? 502

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorMsg,
        upstream: provider.name, upstreamFormat: provider.format,
        accountName, sessionId, clientName, clientVersion,
      },
    })
    return forwardError(c, error)
  }
}

/** Handle OpenAI-format upstream (translate Anthropic→OpenAI request, translate response back) */
async function handleOpenAIUpstream(
  c: Context,
  requestId: string,
  payload: ChatCompletionsPayload,
  startTime: number,
  provider: ProviderRecord,
  ctx: RequestContext,
  originalModel: string,
) {
  const { accountName, sessionId, clientName, clientVersion } = ctx
  const model = payload.model
  const stream = !!payload.stream

  try {
    const response = await sendOpenAIDirect(provider, payload)

    if (isChatCompletionResponse(response)) {
      const anthropicResponse = translateToAnthropic(response)
      const latencyMs = Math.round(performance.now() - startTime)
      const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (response.usage?.prompt_tokens ?? 0) - cachedTokens
      const outputTokens = response.usage?.completion_tokens ?? 0

      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `200 ${model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages", format: "anthropic", model: originalModel,
          resolvedModel: response.model, translatedModel: model,
          inputTokens, outputTokens, latencyMs,
          ttftMs: null, processingMs: null,
          stream: false, status: "success", statusCode: 200,
          upstreamStatus: 200, upstream: provider.name, upstreamFormat: provider.format,
          accountName, sessionId, clientName, clientVersion,
        },
      })

      return c.json(anthropicResponse)
    }

    // Streaming: translate OpenAI chunks → Anthropic events
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    let resolvedModel = model
    let inputTokens = 0
    let outputTokens = 0
    let streamError: string | null = null
    let firstChunkTime: number | null = null
    let lastToolCallCount = 0

    return streamSSE(c, async (sseStream) => {
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

          // Debug: detect new tool calls
          if (state.optToolCallDebug) {
            const currentToolCallCount = Object.keys(streamState.toolCalls).length
            if (currentToolCallCount > lastToolCallCount) {
              const newToolCall = Object.values(streamState.toolCalls).reduce((newest, tc) =>
                tc.anthropicBlockIndex > newest.anthropicBlockIndex ? tc : newest,
                { id: "", name: "", anthropicBlockIndex: -1 },
              )
              if (newToolCall.id) {
                logEmitter.emitLog({
                  ts: Date.now(), level: "debug", type: "sse_chunk", requestId,
                  msg: `tool_use started: ${newToolCall.name}`,
                  data: {
                    eventType: "tool_use_start",
                    toolName: newToolCall.name,
                    toolId: newToolCall.id,
                    blockIndex: newToolCall.anthropicBlockIndex,
                  },
                })
              }
            }
            lastToolCallCount = currentToolCallCount
          }

          for (const event of events) {
            await sseStream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? `stream error: ${err.message}` : "stream error"

        try {
          const errorEvent = translateErrorToAnthropicErrorEvent()
          await sseStream.writeSSE({
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
          })
        } catch {
          // Connection may be closed
        }
      } finally {
        const endTime = performance.now()
        const latencyMs = Math.round(endTime - startTime)
        const ttftMs = firstChunkTime !== null ? Math.round(firstChunkTime - startTime) : null
        const processingMs = firstChunkTime !== null ? Math.round(endTime - firstChunkTime) : null

        const baseData = {
          path: "/v1/messages", format: "anthropic", model: originalModel,
          resolvedModel, translatedModel: model,
          inputTokens, outputTokens, latencyMs, ttftMs, processingMs,
          stream: true, status: streamError ? "error" : "success",
          statusCode: streamError ? 502 : 200,
          upstreamStatus: streamError ? null : 200,
          upstream: provider.name, upstreamFormat: provider.format,
          accountName, sessionId, clientName, clientVersion,
        }

        const debugData = state.optToolCallDebug && !streamError ? {
          stopReason: "tool_use",
          toolCallCount: Object.keys(streamState.toolCalls).length,
          toolCallNames: Object.values(streamState.toolCalls).map(tc => tc.name),
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
    const errorMsg = error instanceof Error ? error.message : String(error)
    // Extract upstream status from HTTPError for accurate logging
    const upstreamStatus = error instanceof HTTPError ? error.response.status : null
    const statusCode = upstreamStatus ?? 502

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model: originalModel, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorMsg,
        upstream: provider.name, upstreamFormat: provider.format,
        accountName, sessionId, clientName, clientVersion,
      },
    })
    return forwardError(c, error)
  }
}

/** Type guard for Anthropic non-streaming response */
function isAnthropicNonStreaming(
  response: Awaited<ReturnType<typeof sendAnthropicDirect>>,
): response is AnthropicResponse {
  return typeof response === "object" && "type" in response && response.type === "message"
}

/** Type guard for OpenAI non-streaming response */
function isChatCompletionResponse(
  response: Awaited<ReturnType<typeof sendOpenAIDirect>>,
): response is ChatCompletionResponse {
  return typeof response === "object" && "object" in response && response.object === "chat.completion"
}
