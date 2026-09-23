import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { UpstreamFormat } from "../core/routing-types"
import { ClientInputError } from "../lib/error"
import type { AnthropicMessagesPayload, AnthropicResponse } from "../protocols/anthropic/types"
import {
  assertChatViaResponsesSupported,
  chatRequestToResponses,
} from "../protocols/chat-responses/request"
import { adaptResponsesEventToChatChunks, initChatViaResponsesStreamState } from "../protocols/chat-responses/stream"
import type { ChatViaResponsesClientReq, ChatViaResponsesStreamState } from "../protocols/chat-responses/types"
import {
  adaptAnthropicEventToChatSse,
  anthropicResponseToChat,
  chatRequestToMessages,
  finalizeAnthropicToChatStream,
  initAnthropicToChatStreamState,
  parseAnthropicSseData,
  type AnthropicToChatStreamState,
} from "../protocols/cross-format/chat-messages"
import {
  adaptResponsesEventToAnthropicSse,
  anthropicStreamErrorEvent,
  finalizeMessagesViaResponsesStream,
  initMessagesViaResponsesStreamState,
  messagesToResponsesPayload,
  responsesJsonToAnthropicMessage,
  type MessagesViaResponsesStreamState,
} from "../protocols/cross-format/messages-to-responses"
import {
  adaptChatChunkToResponsesSse,
  finalizeChatToResponsesStream,
  chatJsonToResponses,
  initChatToResponsesStreamState,
  parseChatChunk,
  responsesJsonToChat,
  responsesRequestToChat,
  type ChatToResponsesStreamState,
} from "../protocols/cross-format/responses-chat"
import { extractNonStreamingMeta, isTerminalResponseEvent, nonCachedInputTokens } from "../protocols/responses/stream-state"
import type { ChatCompletionsPayload, ChatCompletionResponse } from "../upstream/copilot-openai"
import type { ResponsesPayload } from "../upstream/copilot-responses"
import type { UpstreamResult } from "../upstream/interface"
import type { ServerSentEvent } from "../util/sse"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import { isInlineStreamError } from "./support/inline-stream-error"

export interface ProtocolConvertedDeps {
  source: UpstreamFormat
  target: UpstreamFormat
  exactModel: boolean
  includeUsage?: boolean
  copilotSanitize?: boolean
  sanitizeOrphanedToolResults?: boolean
  reorderToolResults?: boolean
  client: {
    send(wire: ConvertedBody, signal?: AbortSignal): Promise<UpstreamResult<unknown>>
  }
}

type ConvertedBody = AnthropicMessagesPayload | ChatCompletionsPayload | ResponsesPayload

type ConversionKind =
  | "responses-passthrough"
  | "messages-to-responses"
  | "chat-to-messages"
  | "chat-to-responses"
  | "responses-to-chat"
  | "responses-to-messages"

export interface ProtocolConvertedState {
  kind: ConversionKind
  model: string
  inlineFailed: boolean
  terminalSeen: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  messages?: MessagesViaResponsesStreamState
  anthropic?: AnthropicToChatStreamState
  responses?: ChatToResponsesStreamState
  chat?: ChatViaResponsesStreamState
}

function conversionKind(source: UpstreamFormat, target: UpstreamFormat): ConversionKind {
  if (source === target) {
    if (source !== "responses") {
      throw new ClientInputError("native forwarding is not protocol-converted")
    }
    return "responses-passthrough"
  }
  if (source === "anthropic_messages" && target === "responses") return "messages-to-responses"
  if (source === "chat_completions" && target === "anthropic_messages") return "chat-to-messages"
  if (source === "chat_completions" && target === "responses") return "chat-to-responses"
  if (source === "responses" && target === "chat_completions") return "responses-to-chat"
  if (source === "responses" && target === "anthropic_messages") return "responses-to-messages"
  throw new ClientInputError(`conversion from ${source} to ${target} is not supported`)
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}

function streamUsage(
  kind: ConversionKind,
  state: ProtocolConvertedState,
): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
} {
  if ((kind === "chat-to-messages" || kind === "responses-to-messages") && state.anthropic) {
    return {
      inputTokens: state.anthropic.inputTokens,
      outputTokens: state.anthropic.outputTokens,
      cacheReadTokens: state.anthropic.cacheReadTokens,
      cacheCreationTokens: state.anthropic.cacheCreationTokens,
    }
  }
  if (kind === "responses-to-chat" && state.responses) {
    return {
      inputTokens: nonCachedInputTokens(state.responses.inputTokens, state.responses.cacheReadTokens),
      outputTokens: state.responses.outputTokens,
      cacheReadTokens: state.responses.cacheReadTokens,
      cacheCreationTokens: 0,
    }
  }
  const input = state.messages?.chat.inputTokens ?? state.chat?.inputTokens ?? state.inputTokens
  const output = state.messages?.chat.outputTokens ?? state.chat?.outputTokens ?? state.outputTokens
  const cache = state.messages?.chat.cacheReadTokens ?? state.chat?.cacheReadTokens ?? state.cacheReadTokens
  return {
    inputTokens: nonCachedInputTokens(input, cache),
    outputTokens: output,
    cacheReadTokens: cache,
    cacheCreationTokens: 0,
  }
}

function modelOf(body: ConvertedBody): string {
  return body.model
}

export function makeProtocolConverted(deps: ProtocolConvertedDeps): Strategy<
  ConvertedBody,
  ConvertedBody,
  unknown,
  unknown,
  ServerSentEvent,
  SSEMessage,
  ProtocolConvertedState
> {
  const kind = conversionKind(deps.source, deps.target)
  return {
    name: "protocol-converted",
    prepare: (req, ctx) => {
      if (kind === "responses-passthrough") return req
      if (kind === "messages-to-responses") {
        return messagesToResponsesPayload(req as AnthropicMessagesPayload, {
          copilotSanitize: deps.copilotSanitize === true,
          exactModel: deps.exactModel,
          anthropicBeta: ctx.anthropicBeta,
          sanitizeOrphanedToolResults: deps.sanitizeOrphanedToolResults ?? false,
          reorderToolResults: deps.reorderToolResults ?? false,
        })
      }
      if (kind === "chat-to-messages") return chatRequestToMessages(req as ChatCompletionsPayload)
      if (kind === "chat-to-responses") {
        const chat = req as ChatViaResponsesClientReq
        assertChatViaResponsesSupported(chat)
        const wire = chatRequestToResponses(chat)
        if (deps.exactModel) wire.model = chat.model
        return wire
      }
      if (kind === "responses-to-chat") return responsesRequestToChat(req as ResponsesPayload)
      return chatRequestToMessages(responsesRequestToChat(req as ResponsesPayload))
    },
    dispatch: async (up, ctx) => {
      ctx.signal?.throwIfAborted()
      const response = await deps.client.send(up, ctx.signal)
      const stream = up && typeof up === "object" && "stream" in up && up.stream === true
      if (stream && isAsyncIterable<ServerSentEvent>(response)) {
        return { kind: "stream", chunks: response }
      }
      return { kind: "json", body: response }
    },
    adaptJson: (resp, req) => {
      const model = modelOf(req)
      if (kind === "responses-passthrough") return resp
      if (kind === "messages-to-responses") return responsesJsonToAnthropicMessage(resp, model)
      if (kind === "chat-to-messages") return anthropicResponseToChat(resp as AnthropicResponse)
      if (kind === "chat-to-responses") return responsesJsonToChat(resp, model)
      if (kind === "responses-to-chat") return chatJsonToResponses(resp as ChatCompletionResponse)
      return chatJsonToResponses(anthropicResponseToChat(resp as AnthropicResponse))
    },
    initStreamState: (req) => {
      const model = modelOf(req)
      const state: ProtocolConvertedState = {
        kind,
        model,
        inlineFailed: false,
        terminalSeen: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      }
      if (kind === "messages-to-responses") state.messages = initMessagesViaResponsesStreamState(model)
      if (kind === "chat-to-messages" || kind === "responses-to-messages") {
        state.anthropic = initAnthropicToChatStreamState(model)
      }
      if (kind === "responses-to-chat" || kind === "responses-to-messages") {
        state.responses = initChatToResponsesStreamState(model)
      }
      if (kind === "chat-to-responses") {
        state.chat = initChatViaResponsesStreamState({ model, includeUsage: deps.includeUsage ?? false })
      }
      return state
    },
    adaptChunk: (chunk, state, ctx) => {
      emitUpstreamRawSse(ctx.requestId, {
        event: chunk.event,
        data: typeof chunk.data === "string" ? chunk.data : "",
      })
      switch (kind) {
        case "responses-passthrough":
          return adaptPassthrough(chunk, state)
        case "messages-to-responses":
          return adaptResponsesEventToAnthropicSse(chunk, state.messages!)
        case "chat-to-responses":
          return adaptResponsesEventToChatChunks(chunk, state.chat!)
        case "chat-to-messages":
        case "responses-to-messages": {
          const event = typeof chunk.data === "string" ? parseAnthropicSseData(chunk.data) : null
          if (!event) return []
          const chatEvents = adaptAnthropicEventToChatSse(event, state.anthropic!)
          state.inlineFailed = state.anthropic!.inlineFailed
          if (kind === "chat-to-messages") return chatEvents
          const out: SSEMessage[] = []
          for (const chatEvent of chatEvents) {
            const parsed = typeof chatEvent.data === "string" ? parseChatChunk(chatEvent.data) : null
            if (!parsed) continue
            out.push(...adaptChatChunkToResponsesSse(parsed, state.responses!))
          }
          state.inlineFailed ||= state.responses!.inlineFailed
          return out
        }
        case "responses-to-chat": {
          if (chunk.data === "[DONE]") return finalizeChatToResponsesStream(state.responses!)
          const parsed = typeof chunk.data === "string" ? parseChatChunk(chunk.data) : null
          if (!parsed) return []
          const events = adaptChatChunkToResponsesSse(parsed, state.responses!)
          state.inlineFailed = state.responses!.inlineFailed
          state.terminalSeen = state.responses!.done
          return events
        }
      }
    },
    streamOutcome: (state) =>
      state.inlineFailed || state.anthropic?.inlineFailed || state.responses?.inlineFailed
        ? "error"
        : "success",
    finalizeStream: (state) => {
      if (state.inlineFailed || state.anthropic?.inlineFailed || state.responses?.inlineFailed) return []
      switch (kind) {
        case "responses-passthrough":
          if (!state.terminalSeen) throw new Error("Truncated stream: terminal response event was not received")
          return []
        case "messages-to-responses":
          return finalizeMessagesViaResponsesStream(state.messages!)
        case "chat-to-responses":
          if (!state.chat!.done) throw new Error("Truncated stream: terminal response event was not received")
          return []
        case "chat-to-messages":
          return finalizeAnthropicToChatStream(state.anthropic!, deps.includeUsage ?? false)
        case "responses-to-chat":
          return finalizeChatToResponsesStream(state.responses!)
        case "responses-to-messages": {
          if (state.anthropic!.inlineFailed || state.responses!.inlineFailed) return []
          const tail = finalizeAnthropicToChatStream(state.anthropic!)
          const out: SSEMessage[] = []
          for (const chatEvent of tail) {
            const parsed = typeof chatEvent.data === "string" ? parseChatChunk(chatEvent.data) : null
            if (!parsed) continue
            out.push(...adaptChatChunkToResponsesSse(parsed, state.responses!))
          }
          out.push(...finalizeChatToResponsesStream(state.responses!))
          return out
        }
      }
    },
    adaptStreamError: (err) => {
      const message = err instanceof Error ? err.message : "An upstream error occurred during streaming."
      if (deps.source === "chat_completions") {
        return [{
          data: JSON.stringify({
            error: { message, type: "server_error", code: "stream_error" },
          }),
        }]
      }
      if (deps.source === "anthropic_messages") {
        const event = anthropicStreamErrorEvent()
        const raw = typeof event.data === "string" ? event.data : "{}"
        const body = JSON.parse(raw) as { error: { message: string } }
        body.error.message = message
        return [{ event: "error", data: JSON.stringify(body) }]
      }
      return [{
        event: "error",
        data: JSON.stringify({ type: "error", message }),
      }]
    },
    describeEndLog: (result) => {
      if (result.kind === "json") {
        if (kind === "chat-to-messages" || kind === "responses-to-messages") {
          const body = result.resp as AnthropicResponse
          const cache = body.usage?.cache_read_input_tokens ?? 0
          return {
            model: modelOf(result.req),
            resolvedModel: body.model,
            inputTokens: body.usage?.input_tokens ?? 0,
            outputTokens: body.usage?.output_tokens ?? 0,
            cacheReadTokens: cache,
            cacheCreationTokens: body.usage?.cache_creation_input_tokens ?? 0,
            routingPath: kind,
          }
        }
        if (kind === "responses-to-chat") {
          const body = result.resp as ChatCompletionResponse
          const cache = body.usage?.prompt_tokens_details?.cached_tokens ?? 0
          return {
            model: modelOf(result.req),
            resolvedModel: body.model,
            inputTokens: (body.usage?.prompt_tokens ?? 0) - cache,
            outputTokens: body.usage?.completion_tokens ?? 0,
            cacheReadTokens: cache,
            cacheCreationTokens: 0,
            routingPath: kind,
          }
        }
        const meta = extractNonStreamingMeta(result.resp, modelOf(result.req))
        return {
          model: modelOf(result.req),
          resolvedModel: meta.resolvedModel,
          inputTokens: nonCachedInputTokens(meta.inputTokens, meta.cachedInputTokens),
          outputTokens: meta.outputTokens,
          cacheReadTokens: meta.cachedInputTokens,
          cacheCreationTokens: 0,
          routingPath: kind,
        }
      }
      if (result.kind === "stream") {
        const usage = streamUsage(kind, result.state)
        return {
          model: modelOf(result.req),
          resolvedModel: result.state.model,
          ...usage,
          routingPath: kind,
        }
      }
      return { model: modelOf(result.req), routingPath: kind }
    },
  }
}

function adaptPassthrough(chunk: ServerSentEvent, state: ProtocolConvertedState): SSEMessage[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(chunk.data)
  } catch {
    parsed = undefined
  }
  state.inlineFailed ||= isInlineStreamError(chunk.event, parsed)
  const eventName = chunk.event ?? (parsed && typeof parsed === "object" ? (parsed as { type?: string }).type : undefined)
  if (isTerminalResponseEvent(eventName)) {
    state.terminalSeen = true
    const meta = extractNonStreamingMeta(
      parsed && typeof parsed === "object" && "response" in parsed ? (parsed as { response?: unknown }).response : parsed,
      state.model,
    )
    state.model = meta.resolvedModel || state.model
    state.inputTokens = meta.inputTokens
    state.outputTokens = meta.outputTokens
    state.cacheReadTokens = meta.cachedInputTokens
  }
  const message: SSEMessage = { data: chunk.data }
  if (chunk.event) message.event = chunk.event
  if (chunk.id) message.id = chunk.id
  if (chunk.retry != null) message.retry = chunk.retry
  return [message]
}
