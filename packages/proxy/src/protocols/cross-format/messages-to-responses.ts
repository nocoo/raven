import type { SSEMessage } from "hono/streaming"

import { ClientInputError } from "../../lib/error"
import type {
  AnthropicMessagesPayload,
  AnthropicStreamEventData,
  AnthropicToolUseBlock,
} from "../anthropic/types"
import {
  assertChatViaResponsesSupported,
  chatRequestToResponses,
} from "../chat-responses/request"
import { responsesJsonToChatCompletion } from "../chat-responses/response"
import {
  adaptResponsesEventToChatChunks,
  initChatViaResponsesStreamState,
} from "../chat-responses/stream"
import type { ChatViaResponsesStreamState } from "../chat-responses/types"
import {
  createAnthropicStreamState,
  finalizeAnthropicStream,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "../translate/stream-translation"
import {
  filterContentBlocks,
  sanitizeToolDefinitions,
  stripToolUseFields,
  translateToAnthropic,
  translateToOpenAI,
} from "../translate/non-stream-translation"
import type { ChatCompletionChunk } from "../../upstream/copilot-openai"
import type { ResponsesPayload } from "../../upstream/copilot-responses"
import type { ServerSentEvent } from "../../util/sse"
import { rejectUnsupportedMessages } from "./reject"

export interface MessagesToResponsesOptions {
  /** Run Copilot translation sanitizers before validation. */
  copilotSanitize: boolean
  /** Keep the caller model id. Custom upstreams require this. */
  exactModel: boolean
  anthropicBeta?: string | null
  sanitizeOrphanedToolResults?: boolean
  reorderToolResults?: boolean
}

export function messagesToResponsesPayload(
  payload: AnthropicMessagesPayload,
  options: MessagesToResponsesOptions,
): ResponsesPayload {
  const source = options.copilotSanitize ? sanitizeCopilotMessages(payload) : payload
  rejectUnsupportedMessages(source)
  const chat = translateToOpenAI(source, {
    targetFormat: options.copilotSanitize ? "copilot" : "openai",
    anthropicBeta: options.anthropicBeta ?? null,
    sanitizeOrphanedToolResults: options.sanitizeOrphanedToolResults ?? false,
    reorderToolResults: options.reorderToolResults ?? false,
  })
  if (options.exactModel) chat.model = payload.model
  if (source.stop_sequences != null && source.stop_sequences.length > 0) {
    throw new ClientInputError("stop_sequences are not supported on messages-to-responses")
  }
  const chatReq = chat as unknown as Parameters<typeof chatRequestToResponses>[0]
  assertChatViaResponsesSupported(chatReq)
  return chatRequestToResponses(chatReq)
}

export function responsesJsonToAnthropicMessage(
  body: unknown,
  originalModel: string,
) {
  return translateToAnthropic(responsesJsonToChatCompletion(body, originalModel), originalModel)
}

export interface MessagesViaResponsesStreamState {
  chat: ChatViaResponsesStreamState
  anthropic: ReturnType<typeof createAnthropicStreamState>
  originalModel: string
}

export function initMessagesViaResponsesStreamState(
  model: string,
): MessagesViaResponsesStreamState {
  return {
    chat: initChatViaResponsesStreamState({ model, includeUsage: true }),
    anthropic: createAnthropicStreamState(),
    originalModel: model,
  }
}

export function adaptResponsesEventToAnthropicSse(
  chunk: ServerSentEvent,
  state: MessagesViaResponsesStreamState,
): SSEMessage[] {
  if (chunk.data === "[DONE]") return []
  const chatEvents = adaptResponsesEventToChatChunks(chunk, state.chat)
  const out: SSEMessage[] = []
  for (const event of chatEvents) {
    if (typeof event.data !== "string" || event.data === "[DONE]") continue
    const parsed = JSON.parse(event.data) as ChatCompletionChunk
    const anthropicEvents = translateChunkToAnthropicEvents(
      normalizeChunk(parsed),
      state.anthropic,
      state.originalModel,
    )
    for (const item of anthropicEvents) out.push(anthropicSse(item))
  }
  return out
}

export function finalizeMessagesViaResponsesStream(
  state: MessagesViaResponsesStreamState,
): SSEMessage[] {
  return finalizeAnthropicStream(state.anthropic).map(anthropicSse)
}

export function anthropicStreamErrorEvent(): SSEMessage {
  const errorEvent = translateErrorToAnthropicErrorEvent()
  return anthropicSse(errorEvent)
}

function anthropicSse(event: AnthropicStreamEventData): SSEMessage {
  return { event: event.type, data: JSON.stringify(event) }
}

function normalizeChunk(chunk: ChatCompletionChunk): ChatCompletionChunk {
  return {
    ...chunk,
    usage: chunk.usage ?? null,
    system_fingerprint: chunk.system_fingerprint ?? null,
    choices: (chunk.choices ?? []).map((choice) => ({
      ...choice,
      delta: {
        content: choice.delta?.content ?? null,
        role: choice.delta?.role ?? null,
        refusal: choice.delta?.refusal ?? null,
        tool_calls: choice.delta?.tool_calls ?? null,
      },
      finish_reason: choice.finish_reason ?? null,
      logprobs: choice.logprobs ?? null,
    })),
  }
}

function sanitizeCopilotMessages(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const copy = structuredClone(payload)
  if (copy.tools) sanitizeToolDefinitions(copy.tools)
  copy.messages = copy.messages.map((message) => {
    if (typeof message.content === "string") return message
    const blocks = filterContentBlocks(message.content as Array<{ type: string }>)
    for (const block of blocks) {
      if (block.type === "tool_use") stripToolUseFields(block as AnthropicToolUseBlock)
    }
    return { ...message, content: blocks as typeof message.content }
  }) as AnthropicMessagesPayload["messages"]
  return copy
}
