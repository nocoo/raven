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
  type ToolCall,
} from "./../../services/copilot/create-chat-completions"
import type { ServerSentEvent } from "./../../util/sse"
import { extractErrorDetails, forwardError, HTTPError } from "./../../lib/error"

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
        toolDefinitions: anthropicPayload.tools.map((t: { name: string; type?: string }) => ({ name: t.name, type: t.type ?? "none" })),
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
    const targetFormat = provider.supports_reasoning ? "openai-reasoning" : "openai"
    const openAIPayload = translateToOpenAI(anthropicPayload, { targetFormat })
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

  const openAIPayload = translateToOpenAI(anthropicPayload, { targetFormat: "copilot" })

  // Warn if thinking was requested but dropped (Copilot doesn't support it)
  if (anthropicPayload.thinking?.type === "enabled") {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "warn",
      type: "request_start",
      requestId,
      msg: "thinking parameter dropped: Copilot does not support extended thinking",
      data: {
        budgetTokens: anthropicPayload.thinking.budget_tokens,
        hint: "Configure an Anthropic provider to use thinking",
      },
    })
  }

  const serverSideToolNames = openAIPayload.serverSideToolNames ?? []

  // Check if we need to handle server-side tools (web_search)
  const hasServerSideTools = serverSideToolNames.length > 0
  const webSearchEnabled = state.stWebSearchEnabled && state.stWebSearchApiKey !== null

  // Debug: log server-tool detection result
  if (state.optToolCallDebug) {
    logEmitter.emitLog({
      ts: Date.now(), level: "debug", type: "request_start", requestId,
      msg: `server-tool check: hasServerSideTools=${hasServerSideTools}, webSearchEnabled=${webSearchEnabled}, serverSideToolNames=${JSON.stringify(serverSideToolNames)}`,
      data: {
        hasServerSideTools, webSearchEnabled, serverSideToolNames,
        stWebSearchEnabled: state.stWebSearchEnabled,
        stWebSearchApiKey: state.stWebSearchApiKey ? "***" : null,
      },
    })
  }

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
    // Server-side tool interception loop may return AnthropicResponse directly
    // (pure mode) or ChatCompletionResponse (mixed mode / normal flow)
    let serverToolResult: ServerToolResult | undefined
    let response: Awaited<ReturnType<typeof createChatCompletions>>

    if (hasServerSideTools && webSearchEnabled) {
      serverToolResult = await handleServerToolLoop(
        finalPayload,
        serverSideToolNames,
        requestId,
        stream,
      )
      // Pure server-side mode returns AnthropicResponse directly
      if (isAnthropicResponse(serverToolResult)) {
        const latencyMs = Math.round(performance.now() - startTime)

        logEmitter.emitLog({
          ts: Date.now(), level: "info", type: "request_end", requestId,
          msg: `200 ${model} ${latencyMs}ms`,
          data: {
            path: "/v1/messages", format: "anthropic", model,
            resolvedModel: serverToolResult.model,
            translatedModel: finalPayload.model,
            inputTokens: serverToolResult.usage.input_tokens,
            outputTokens: serverToolResult.usage.output_tokens,
            latencyMs,
            ttftMs: null, processingMs: null,
            stream: false, status: "success", statusCode: 200,
            upstreamStatus: 200, accountName, sessionId, clientName, clientVersion,
          },
        })

        // Client requested streaming — emit as SSE events
        if (stream) {
          return streamAnthropicResponse(c, serverToolResult)
        }
        return c.json(serverToolResult)
      }
      response = serverToolResult
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
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorDetail, accountName,
        sessionId, clientName, clientVersion,
      },
    })
    throw error
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>> | ChatCompletionResponse,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

// ===========================================================================
// Server-side tool interception
// ===========================================================================

/**
 * Handle requests that include server-side tools (e.g., web_search).
 *
 * Two modes:
 *
 * **Pure server-side** (all tools are server-side, e.g. only web_search):
 *   - Extract query from messages, call Tavily directly (no upstream call)
 *   - Inject search results into messages, then call upstream without tools
 *     to let the model synthesize a final answer
 *
 * **Mixed** (has both client and server-side tools):
 *   - Strip server-side tool definitions, send to upstream with client tools only
 *   - If upstream returns a tool_call matching a server-side tool name, execute it
 *   - Inject results and loop (up to maxIterations)
 *
 * This is done server-side, transparent to the client.
 */
export type ServerToolResult = ChatCompletionResponse | AnthropicResponse

export async function handleServerToolLoop(
  payload: ExtendedChatCompletionsPayload,
  serverSideToolNames: string[],
  requestId: string,
  _clientRequestedStream: boolean,
): Promise<ServerToolResult> {
  // Separate client-side and server-side tools
  const clientTools = payload.tools?.filter(
    (t) => !serverSideToolNames.includes(t.function.name),
  )
  const hasClientTools = clientTools && clientTools.length > 0

  // --- Pure server-side mode: all tools are server-side ---
  if (!hasClientTools) {
    return handlePureServerSideTools(payload, serverSideToolNames, requestId)
  }

  // --- Mixed mode: has both client and server-side tools ---
  return handleMixedTools(payload, serverSideToolNames, clientTools, requestId)
}

/**
 * Pure server-side tool handling.
 * Extract query from user message, call Tavily, inject results,
 * then call upstream (no tools) for the model to synthesize an answer.
 *
 * Returns an AnthropicResponse directly (bypasses translateToAnthropic)
 * with proper server_tool_use + web_search_tool_result + text blocks.
 */
async function handlePureServerSideTools(
  payload: ExtendedChatCompletionsPayload,
  serverSideToolNames: string[],
  requestId: string,
): Promise<AnthropicResponse> {
  // Extract search query from the last user message
  const lastUserMessage = [...payload.messages].reverse().find((m) => m.role === "user")
  const query = extractTextContent(lastUserMessage?.content)

  if (!query) {
    // No extractable query — fall through to upstream without tools,
    // return as plain text response
    const streamResponse = await createChatCompletions({
      ...payload,
      stream: true,
      tools: null,
      tool_choice: null,
    })
    const resp = await consumeStreamToResponse(streamResponse as AsyncGenerator<ServerSentEvent>)
    const anthropicResp = translateToAnthropic(resp)
    return anthropicResp
  }

  // Execute web_search via Tavily
  const toolName = serverSideToolNames.find((n) => n === "web_search") ?? serverSideToolNames[0] ?? "web_search"

  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "sse_chunk", requestId,
    msg: `server-side tool direct call: ${toolName}`,
    data: { eventType: "server_tool_direct", toolName, query },
  })

  let searchResult: Awaited<ReturnType<typeof searchTavily>>
  if (state.stWebSearchApiKey) {
    try {
      searchResult = await searchTavily(state.stWebSearchApiKey, { query })
    } catch (err) {
      if (err instanceof TavilyError) {
        logEmitter.emitLog({
          ts: Date.now(), level: "error", type: "sse_chunk", requestId,
          msg: `server tool error: ${toolName} - ${err.message}`,
          data: { eventType: "server_tool_error", toolName, errorType: err.type, statusCode: err.statusCode },
        })
        throw new HTTPError(err.message, err.statusCode, err.message)
      }
      throw err
    }
  } else {
    throw new HTTPError(`Server tool ${toolName} is not available`, 500, `Server tool ${toolName} is not available`)
  }

  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "sse_chunk", requestId,
    msg: `server tool result obtained: ${toolName}`,
    data: { eventType: "server_tool_result", toolName, resultCount: searchResult.content.length },
  })

  // Inject search results and call upstream for synthesis (no tools)
  const synthesisPayload: ChatCompletionsPayload = {
    ...payload,
    stream: true,
    tools: null,
    tool_choice: null,
    messages: [
      ...payload.messages,
      {
        role: "user",
        content: `[web_search results for "${query}"]\n\n${searchResult.textContent}`,
        name: null,
        tool_calls: null,
        tool_call_id: null,
      },
    ],
  }

  const streamResponse = await createChatCompletions(synthesisPayload)
  const synthesisResp = await consumeStreamToResponse(streamResponse as AsyncGenerator<ServerSentEvent>)

  // Build Anthropic-native response with server_tool_use + web_search_tool_result + text
  const toolUseId = `srvtoolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const synthesizedText = synthesisResp.choices[0]?.message.content || ""
  const cachedTokens = synthesisResp.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const inputTokens = (synthesisResp.usage?.prompt_tokens ?? 0) - cachedTokens
  const outputTokens = synthesisResp.usage?.completion_tokens ?? 0

  return {
    id: synthesisResp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: synthesisResp.model || payload.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      {
        type: "server_tool_use",
        id: toolUseId,
        name: toolName,
        input: { query },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: searchResult.content,
      },
      {
        type: "text",
        text: synthesizedText,
      },
    ],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: cachedTokens || null,
      service_tier: null,
      server_tool_use: { web_search_requests: 1 },
    },
  }
}

/**
 * Mixed tool handling: client tools + server-side tools.
 * Strip server-side tool defs, send to upstream with client tools only.
 * If model calls a server-side tool name, execute it and loop.
 */
async function handleMixedTools(
  payload: ExtendedChatCompletionsPayload,
  serverSideToolNames: string[],
  clientTools: NonNullable<ChatCompletionsPayload["tools"]>,
  requestId: string,
): Promise<ChatCompletionResponse> {
  const maxIterations = 5
  let iteration = 0
  let currentPayload: ChatCompletionsPayload = payload

  while (iteration < maxIterations) {
    iteration++

    const loopPayload: ChatCompletionsPayload = {
      ...currentPayload,
      stream: true,
      tools: clientTools,
      tool_choice: iteration > 1 ? "auto" : (currentPayload.tool_choice ?? "auto"),
    }

    const streamResponse = await createChatCompletions(loopPayload)
    const response = await consumeStreamToResponse(
      streamResponse as AsyncGenerator<ServerSentEvent>,
    )

    const toolCalls = response.choices[0]?.message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      return response
    }

    const serverToolCall = toolCalls.find((tc: { function?: { name: string } }) =>
      tc.function && serverSideToolNames.includes(tc.function.name),
    )

    if (!serverToolCall) {
      // Client-side tool call — return to client
      return response
    }

    // Execute server-side tool
    const toolName = serverToolCall.function.name
    const toolInput = JSON.parse(serverToolCall.function.arguments)

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "sse_chunk", requestId,
      msg: `intercepting server-side tool: ${toolName}`,
      data: { eventType: "server_tool_intercept", toolName, toolInput },
    })

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
          logEmitter.emitLog({
            ts: Date.now(), level: "error", type: "sse_chunk", requestId,
            msg: `server tool error: ${toolName} - ${err.message}`,
            data: { eventType: "server_tool_error", toolName, errorType: err.type, statusCode: err.statusCode },
          })
          throw new HTTPError(err.message, err.statusCode, err.message)
        }
        throw err
      }
    } else {
      throw new HTTPError(`Server tool ${toolName} is not available`, 500, `Server tool ${toolName} is not available`)
    }

    // Inject tool result and loop
    const assistantMessage: ChatCompletionsPayload["messages"][0] = {
      role: "assistant",
      content: response.choices[0]?.message.content || "",
      tool_calls: [serverToolCall],
      name: null,
      tool_call_id: null,
    }

    const toolMessage: ChatCompletionsPayload["messages"][0] = {
      role: "tool",
      content: JSON.stringify(toolResult),
      tool_call_id: serverToolCall.id,
      name: null,
      tool_calls: null,
    }

    currentPayload = {
      ...currentPayload,
      messages: [...currentPayload.messages, assistantMessage, toolMessage],
    }

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "sse_chunk", requestId,
      msg: `server tool result injected: ${toolName}`,
      data: { eventType: "server_tool_result", toolName, resultLength: JSON.stringify(toolResult).length },
    })
  }

  throw new Error("Server tool loop exceeded maximum iterations")
}

/** Extract plain text from a message content field. */
function extractTextContent(content: string | Array<{ type: string; text?: string }> | null | undefined): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
  }
  return ""
}

/**
 * Consume a streaming response and reassemble into a ChatCompletionResponse.
 *
 * This is necessary because Copilot's non-streaming API doesn't include
 * tool_calls data. By using streaming internally, we can correctly extract
 * tool call information from the incremental delta chunks.
 */
export async function consumeStreamToResponse(
  stream: AsyncGenerator<ServerSentEvent>,
): Promise<ChatCompletionResponse> {
  let id = ""
  let model = ""
  let created = 0
  let content = ""
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"

  // Accumulate tool calls by index
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()

  // Usage tracking
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedTokens = 0

  for await (const event of stream) {
    if (event.data === "[DONE]") break
    if (!event.data) continue

    const chunk = JSON.parse(event.data) as ChatCompletionChunk

    // Capture response metadata from first chunk
    if (!id && chunk.id) id = chunk.id
    if (!model && chunk.model) model = chunk.model
    if (!created && chunk.created) created = chunk.created

    // Extract usage from the final chunk (Copilot sends usage in the last chunk)
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? 0
      completionTokens = chunk.usage.completion_tokens ?? 0
      totalTokens = chunk.usage.total_tokens ?? 0
      cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
    }

    const choice = chunk.choices[0]
    if (!choice) continue

    // Accumulate text content
    if (choice.delta?.content) {
      content += choice.delta.content
    }

    // Accumulate tool calls
    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (!tc) continue
        const existing = toolCallMap.get(tc.index)
        if (tc.id && tc.function?.name) {
          // New tool call start
          toolCallMap.set(tc.index, {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments ?? "",
          })
        } else if (existing && tc.function?.arguments) {
          // Argument delta — append
          existing.arguments += tc.function.arguments
        }
      }
    }

    // Capture finish reason
    if (choice.finish_reason) {
      finishReason = choice.finish_reason
    }
  }

  // Build tool_calls array from accumulated map
  const toolCalls: ToolCall[] = Array.from(toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }))

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : null,
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    system_fingerprint: null,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  }
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
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorDetail,
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
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model: originalModel, stream,
        latencyMs, status: "error", statusCode,
        upstreamStatus, error: errorDetail,
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

/** Type guard: distinguish AnthropicResponse from ChatCompletionResponse in server-tool result */
function isAnthropicResponse(
  result: ServerToolResult,
): result is AnthropicResponse {
  return typeof result === "object" && "type" in result && result.type === "message"
}

/** Stream a pre-built AnthropicResponse as SSE events (for clients that requested streaming) */
/**
 * Stream a pre-built AnthropicResponse as SSE events matching the official Anthropic streaming format.
 * Exported for testing.
 *
 * Handles: server_tool_use, web_search_tool_result, text blocks.
 * These are the only block types produced by handlePureServerSideTools.
 */
export function streamAnthropicResponse(c: Context, resp: AnthropicResponse) {
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
        // content_block_start — no input field (sent via delta, per Anthropic spec)
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

        // input_json_delta — send query as one chunk
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
        // content_block_start with full content array
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
        // content_block_start with empty text (per Anthropic convention)
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

/** Type guard for OpenAI non-streaming response */
function isChatCompletionResponse(
  response: Awaited<ReturnType<typeof sendOpenAIDirect>>,
): response is ChatCompletionResponse {
  return typeof response === "object" && "object" in response && response.object === "chat.completion"
}
