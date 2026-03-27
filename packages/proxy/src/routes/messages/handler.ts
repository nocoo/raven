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
  type ExtendedChatCompletionsPayload,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"
import { searchTavily, TavilyError } from "./../../lib/server-tools/tavily"

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
  const serverSideToolNames = openAIPayload.serverSideToolNames ?? []

  // Check if we need to handle server-side tools (web_search)
  const hasServerSideTools = serverSideToolNames.length > 0
  const webSearchEnabled = state.stWebSearchEnabled && state.stWebSearchApiKey !== null

  // tool_choice rewrite: if tool_choice points to a server-side tool, rewrite to "auto"
  // This ensures the upstream model can freely decide to call the tool
  let finalPayload = openAIPayload
  if (hasServerSideTools && webSearchEnabled && openAIPayload.tool_choice) {
    const tc = openAIPayload.tool_choice
    if (typeof tc === "object" && tc.type === "function" &&
        serverSideToolNames.includes(tc.function.name)) {
      logEmitter.emitLog({
        ts: Date.now(),
        level: "info",
        type: "request_start",
        requestId,
        msg: `tool_choice rewritten: ${tc.function.name} → auto (server-side tool)`,
        data: {
          originalToolChoice: tc.function.name,
          newToolChoice: "auto",
        },
      })
      finalPayload = { ...openAIPayload, tool_choice: "auto" }
    }
  }

  try {
    let response: ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>

    // Server-side tool interception loop
    if (hasServerSideTools && webSearchEnabled) {
      response = await handleServerToolLoop(
        finalPayload,
        serverSideToolNames,
        requestId,
        stream,
      )
    } else {
      response = await createChatCompletions(finalPayload)
    }

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
          translatedModel: finalPayload.model,
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
          resolvedModel, translatedModel: finalPayload.model,
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
// Server-side tool interception
// ===========================================================================

/**
 * Internal loop for handling server-side tools (e.g., web_search).
 *
 * The loop:
 * 1. Calls upstream with stream: false (non-streaming)
 * 2. Checks if response contains tool_use for a server-side tool
 * 3. If yes: calls third-party API (Tavily), injects result, loops back to step 1
 * 4. If no: returns final response
 *
 * This is done server-side, transparent to the client.
 */
async function handleServerToolLoop(
  payload: ExtendedChatCompletionsPayload,
  serverSideToolNames: string[],
  requestId: string,
  _clientRequestedStream: boolean,
): Promise<ChatCompletionResponse> {
  const maxIterations = 5 // Prevent infinite loops
  let iteration = 0
  let currentPayload: ChatCompletionsPayload = payload

  while (iteration < maxIterations) {
    iteration++

    // Force non-streaming for internal loop
    const loopPayload: ChatCompletionsPayload = {
      ...currentPayload,
      stream: false,
      // Reset tool_choice to "auto" after first iteration to allow model to decide
      tool_choice: iteration > 1 ? "auto" : (currentPayload.tool_choice as ChatCompletionsPayload["tool_choice"]),
    }

    const response = await createChatCompletions(loopPayload)

    // Ensure response is non-streaming (should always be true with stream: false)
    if (!Object.hasOwn(response, "choices")) {
      // Unexpected streaming response, return as-is
      return response as unknown as ChatCompletionResponse
    }

    const nonStreamingResponse = response as ChatCompletionResponse

    // Check if response contains a tool_use for a server-side tool
    const toolCalls = nonStreamingResponse.choices[0]?.message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls, return final response
      return nonStreamingResponse
    }

    // Find the first tool call that matches a server-side tool
    const serverToolCall = toolCalls.find((tc: { function?: { name: string } }) =>
      tc.function && serverSideToolNames.includes(tc.function.name)
    )

    if (!serverToolCall) {
      // Tool call is for a client-side tool, return response
      return nonStreamingResponse
    }

    // Found a server-side tool call - intercept and execute
    const toolName = serverToolCall.function!.name
    const toolInput = JSON.parse(serverToolCall.function!.arguments)

    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "sse_chunk",
      requestId,
      msg: `intercepting server-side tool: ${toolName}`,
      data: {
        eventType: "server_tool_intercept",
        toolName,
        toolInput,
      },
    })

    // Execute the server-side tool (currently only web_search)
    let toolResult
    if (toolName === "web_search" && state.stWebSearchApiKey) {
      try {
        toolResult = await searchTavily(state.stWebSearchApiKey, {
          query: toolInput.query || "",
          count: toolInput.count,
          offset: toolInput.offset,
        })
      } catch (err) {
        if (err instanceof TavilyError) {
          // Log and rethrow as HTTPError for proper error handling
          logEmitter.emitLog({
            ts: Date.now(),
            level: "error",
            type: "sse_chunk",
            requestId,
            msg: `server tool error: ${toolName} - ${err.message}`,
            data: {
              eventType: "server_tool_error",
              toolName,
              errorType: err.type,
              statusCode: err.statusCode,
            },
          })

          // Return error response
          throw new HTTPError(err.statusCode, err.message)
        }
        throw err
      }
    } else {
      // Server tool enabled but not configured
      throw new HTTPError(500, `Server tool ${toolName} is not available`)
    }

    // Append the tool_use and tool_result to the conversation history
    const assistantMessage: ChatCompletionsPayload["messages"][0] = {
      role: "assistant",
      content: nonStreamingResponse.choices[0]?.message.content || "",
      tool_calls: [serverToolCall],
      name: null,
      tool_call_id: null,
    }

    const userMessage: ChatCompletionsPayload["messages"][0] = {
      role: "user",
      content: JSON.stringify(toolResult),
      tool_call_id: serverToolCall.id,
      name: null,
      tool_calls: null,
    }

    currentPayload = {
      ...currentPayload,
      messages: [
        ...currentPayload.messages,
        assistantMessage,
        userMessage,
      ],
    }

    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "sse_chunk",
      requestId,
      msg: `server tool result injected: ${toolName}`,
      data: {
        eventType: "server_tool_result",
        toolName,
        resultLength: JSON.stringify(toolResult).length,
      },
    })
  }

  // Should not reach here, but just in case
  throw new Error("Server tool loop exceeded maximum iterations")
}

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
