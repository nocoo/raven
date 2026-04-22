/**
 * Native Copilot Anthropic messages handler.
 *
 * Handles Claude models that support native /v1/messages endpoint,
 * bypassing the OpenAI translation layer.
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { state } from "../../lib/state"
import { logEmitter } from "../../util/log-emitter"
import { emitUpstreamRawSse } from "../../util/emit-upstream-raw"
import { extractErrorDetails, forwardError, HTTPError } from "../../lib/error"
import {
  createNativeMessages,
  type NativeMessagesOptions,
} from "../../services/copilot/create-native-messages"
import type { ServerSentEvent } from "../../util/sse"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../protocols/anthropic/types"
import type { ServerToolContext } from "../../protocols/anthropic/preprocess"
import { withServerToolInterception } from "./server-tools"
import {
  parseReasoningEffortError,
  pickSupportedEffort,
  adjustEffortInPayload,
  logEffortFallback,
} from "./effort-fallback"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestContext {
  accountName: string
  sessionId: string
  clientName: string | null
  clientVersion: string | null
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

/**
 * Handle a request via the native Copilot /v1/messages path.
 *
 * This handler:
 * 1. Uses withServerToolInterception for server-side tools
 * 2. Sends directly to Copilot /v1/messages (no translation)
 * 3. Supports both streaming and non-streaming
 */
export async function handleCopilotNative(
  c: Context,
  requestId: string,
  payload: AnthropicMessagesPayload,
  startTime: number,
  copilotModel: string,
  anthropicBeta: string | null,
  serverToolContext: ServerToolContext,
  ctx: RequestContext,
): Promise<Response> {
  const { accountName, sessionId, clientName, clientVersion } = ctx
  const originalModel = payload.model
  const stream = !!payload.stream

  // Build options for native messages service
  const nativeOptions: NativeMessagesOptions = {
    copilotModel,
    anthropicBeta,
  }

  // Web search enabled?
  const webSearchEnabled = state.stWebSearchEnabled && state.stWebSearchApiKey !== null

  // Debug logging for server tools
  if (state.optToolCallDebug && serverToolContext.hasServerSideTools) {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "debug",
      type: "request_start",
      requestId,
      msg: `native path: server-tool check: hasServerSideTools=${serverToolContext.hasServerSideTools}, webSearchEnabled=${webSearchEnabled}`,
      data: {
        hasServerSideTools: serverToolContext.hasServerSideTools,
        webSearchEnabled,
        serverSideToolNames: serverToolContext.serverSideToolNames,
        allServerSide: serverToolContext.allServerSide,
      },
    })
  }

  try {
    // Create the sendRequest function that wraps createNativeMessages for non-streaming
    // with automatic effort fallback
    const sendNonStreamingRequest = createSendNonStreamingRequest(nativeOptions, requestId)

    // Handle server-side tools interception if enabled
    if (serverToolContext.hasServerSideTools && webSearchEnabled) {
      // Server-tool interception uses non-streaming internally
      const response = await withServerToolInterception(
        payload,
        serverToolContext,
        sendNonStreamingRequest,
        requestId,
      )

      const latencyMs = Math.round(performance.now() - startTime)

      logEmitter.emitLog({
        ts: Date.now(),
        level: "info",
        type: "request_end",
        requestId,
        msg: `200 ${originalModel} ${latencyMs}ms (native+server-tools)`,
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: originalModel,
          resolvedModel: response.model,
          copilotModel,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          latencyMs,
          ttftMs: null,
          processingMs: null,
          stream: false,
          status: "success",
          statusCode: 200,
          upstreamStatus: 200,
          routingPath: "native",
          serverToolsUsed: true,
          accountName,
          sessionId,
          clientName,
          clientVersion,
        },
      })

      // If client requested streaming, convert to SSE
      if (stream) {
        return streamAnthropicResponseAsSSE(c, response)
      }
      return c.json(response)
    }

    // No server-side tools: send directly with effort fallback
    const response = await sendWithEffortFallback(payload, nativeOptions, requestId)

    // Non-streaming response
    if (!isAsyncGenerator(response)) {
      const latencyMs = Math.round(performance.now() - startTime)

      logEmitter.emitLog({
        ts: Date.now(),
        level: "info",
        type: "request_end",
        requestId,
        msg: `200 ${originalModel} ${latencyMs}ms (native)`,
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: originalModel,
          resolvedModel: response.model,
          copilotModel,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          latencyMs,
          ttftMs: null,
          processingMs: null,
          stream: false,
          status: "success",
          statusCode: 200,
          upstreamStatus: 200,
          routingPath: "native",
          accountName,
          sessionId,
          clientName,
          clientVersion,
        },
      })

      return c.json(response)
    }

    // Streaming response: passthrough SSE events
    let inputTokens = 0
    let outputTokens = 0
    let streamError: string | null = null
    let firstChunkTime: number | null = null
    let resolvedModel = copilotModel

    return streamSSE(c, async (sseStream) => {
      try {
        for await (const sseEvent of response) {
          emitUpstreamRawSse(requestId, { event: sseEvent.event, data: sseEvent.data })
          if (firstChunkTime === null) firstChunkTime = performance.now()

          // Extract metrics from events
          try {
            const parsed = JSON.parse(sseEvent.data)
            if (parsed.type === "message_start" && parsed.message?.model) {
              resolvedModel = parsed.message.model
            }
            if (parsed.type === "message_delta" && parsed.usage) {
              outputTokens = parsed.usage.output_tokens ?? 0
            }
            if (parsed.type === "message_start" && parsed.message?.usage) {
              inputTokens = parsed.message.usage.input_tokens ?? 0
            }
          } catch {
            // Ignore parse errors for metrics extraction
          }

          // Forward event to client
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
        // Send error event to client
        try {
          await sseStream.writeSSE({
            event: "error",
            data: JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "Upstream stream error" },
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
          ts: Date.now(),
          level: streamError ? "error" : "info",
          type: "request_end",
          requestId,
          msg: `${streamError ? "error" : "200"} ${originalModel} ${latencyMs}ms (native)`,
          data: {
            path: "/v1/messages",
            format: "anthropic",
            model: originalModel,
            resolvedModel,
            copilotModel,
            inputTokens,
            outputTokens,
            latencyMs,
            ttftMs,
            processingMs,
            stream: true,
            status: streamError ? "error" : "success",
            statusCode: streamError ? 502 : 200,
            upstreamStatus: streamError ? null : 200,
            routingPath: "native",
            accountName,
            sessionId,
            clientName,
            clientVersion,
            ...(streamError && { error: streamError }),
          },
        })
      }
    })
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(),
      level: "error",
      type: "request_end",
      requestId,
      msg: `${statusCode} ${originalModel} ${latencyMs}ms (native)`,
      data: {
        path: "/v1/messages",
        format: "anthropic",
        model: originalModel,
        copilotModel,
        stream,
        latencyMs,
        status: "error",
        statusCode,
        upstreamStatus,
        error: errorDetail,
        routingPath: "native",
        accountName,
        sessionId,
        clientName,
        clientVersion,
      },
    })
    return forwardError(c, error)
  }
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/** Type guard for async generator (streaming response) */
function isAsyncGenerator(
  response: AnthropicResponse | AsyncGenerator<ServerSentEvent>,
): response is AsyncGenerator<ServerSentEvent> {
  return typeof (response as AsyncGenerator).next === "function"
}

/**
 * Send a native messages request with automatic effort fallback.
 *
 * If the request fails with invalid_reasoning_effort, parse the error,
 * adjust the effort to a supported value, and retry.
 */
async function sendWithEffortFallback(
  payload: AnthropicMessagesPayload,
  options: NativeMessagesOptions,
  requestId: string,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  try {
    return await createNativeMessages(payload, options)
  } catch (error) {
    // Check if this is an effort error we can retry
    if (!(error instanceof HTTPError)) throw error
    if (error.status !== 400) throw error

    // Try to parse the error body for reasoning effort error
    let errorBody: unknown
    try {
      errorBody = JSON.parse(error.responseBody)
    } catch {
      // Not JSON, can't parse - rethrow original
      throw error
    }

    const effortError = parseReasoningEffortError(errorBody)
    if (!effortError) throw error

    const { requestedEffort, supportedEfforts } = effortError

    // Find fallback effort
    const fallbackEffort = pickSupportedEffort(requestedEffort, supportedEfforts)

    logEffortFallback(requestId, options.copilotModel, requestedEffort, fallbackEffort)

    // Adjust payload and retry
    const adjustedPayload = adjustEffortInPayload(payload, fallbackEffort)
    return await createNativeMessages(adjustedPayload, options)
  }
}

/**
 * Create a non-streaming request function with effort fallback.
 */
function createSendNonStreamingRequest(
  nativeOptions: NativeMessagesOptions,
  requestId: string,
): (p: AnthropicMessagesPayload) => Promise<AnthropicResponse> {
  return async (p: AnthropicMessagesPayload): Promise<AnthropicResponse> => {
    const nonStreamPayload: AnthropicMessagesPayload = { ...p, stream: false }
    const result = await sendWithEffortFallback(nonStreamPayload, nativeOptions, requestId)
    return result as AnthropicResponse
  }
}

/**
 * Stream a pre-built AnthropicResponse as SSE events.
 * Used when server-tool interception returns a response but client requested streaming.
 */
function streamAnthropicResponseAsSSE(c: Context, resp: AnthropicResponse) {
  return streamSSE(c, async (sseStream) => {
    // message_start
    await sseStream.writeSSE({
      event: "message_start",
      data: JSON.stringify({
        type: "message_start",
        message: {
          id: resp.id,
          type: "message",
          role: "assistant",
          content: [],
          model: resp.model,
          stop_reason: null,
          stop_sequence: null,
          usage: resp.usage,
        },
      }),
    })

    // content blocks
    for (let i = 0; i < resp.content.length; i++) {
      const block = resp.content[i]!

      if (block.type === "server_tool_use") {
        // content_block_start
        await sseStream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: {
              type: "server_tool_use",
              id: block.id,
              name: block.name,
            },
          }),
        })

        // input_json_delta
        await sseStream.writeSSE({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: i,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          }),
        })
      } else if (block.type === "web_search_tool_result") {
        // content_block_start with full content
        await sseStream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: block.tool_use_id,
              content: block.content,
            },
          }),
        })
      } else if (block.type === "text") {
        // content_block_start
        await sseStream.writeSSE({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "text", text: "" },
          }),
        })

        // text_delta
        if (block.text) {
          await sseStream.writeSSE({
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              index: i,
              delta: { type: "text_delta", text: block.text },
            }),
          })
        }
      }

      // content_block_stop
      await sseStream.writeSSE({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: i }),
      })
    }

    // message_delta
    await sseStream.writeSSE({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: resp.stop_reason,
          stop_sequence: resp.stop_sequence,
        },
        usage: {
          input_tokens: null,
          output_tokens: resp.usage.output_tokens,
          cache_creation_input_tokens: resp.usage.cache_creation_input_tokens,
          cache_read_input_tokens: resp.usage.cache_read_input_tokens,
        },
      }),
    })

    // message_stop
    await sseStream.writeSSE({
      event: "message_stop",
      data: JSON.stringify({ type: "message_stop" }),
    })
  })
}
