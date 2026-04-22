// ---------------------------------------------------------------------------
// strategies/copilot-translated.ts (H.15)
//
// Promotes `routes/messages/handler.ts::copilotTranslatedShim` (the largest
// strategy: Anthropic client ↔ Copilot OpenAI upstream with full bidirectional
// translation) onto the canonical 7-method `Strategy` interface.
//
// The composition root supplies the upstream client and the per-state knobs
// (`toolCallDebug`, `filterWhitespaceChunks`). Strategy reads no
// `infra/state`.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import { logEmitter } from "../util/log-emitter"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotOpenAIClient,
} from "../upstream/copilot-openai"
import type { AnthropicStreamState } from "../protocols/anthropic/types"
import { translateToAnthropic } from "../protocols/translate/non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "../protocols/translate/stream-translation"

export interface CopilotTranslatedDeps {
  client: CopilotOpenAIClient
  /** Forwarded to translateChunkToAnthropicEvents. */
  filterWhitespaceChunks: boolean
  /** When true, emit `tool_use_start` debug events as new tool calls arrive. */
  toolCallDebug: boolean
}

export interface CopilotTranslatedUpReq {
  /** Already-translated OpenAI payload sent to Copilot */
  openAIPayload: ChatCompletionsPayload
  /** Original Anthropic-side model name (used in translateToAnthropic + logs) */
  originalModel: string
}

export interface CopilotTranslatedStreamState extends AnthropicStreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  lastToolCallCount: number
  originalModel: string
}

const isOpenAINonStreaming = (
  response: ChatCompletionResponse | AsyncGenerator<ServerSentEvent>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

export function makeCopilotTranslated(deps: CopilotTranslatedDeps): Strategy<
  CopilotTranslatedUpReq,
  CopilotTranslatedUpReq,
  ChatCompletionResponse,
  unknown,
  ServerSentEvent,
  SSEMessage,
  CopilotTranslatedStreamState
> {
  return {
    name: "copilot-translated",

    prepare: (req) => req,

    dispatch: async (up) => {
      const response = await deps.client.send(up.openAIPayload)
      if (isOpenAINonStreaming(response)) {
        return { kind: "json", body: response }
      }
      return { kind: "stream", chunks: response }
    },

    adaptJson: (resp, req) => translateToAnthropic(resp, req.originalModel),

    initStreamState: (req) => ({
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      resolvedModel: req.originalModel,
      inputTokens: 0,
      outputTokens: 0,
      lastToolCallCount: 0,
      originalModel: req.originalModel,
    }),

    adaptChunk: (rawEvent, st, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: rawEvent.event, data: rawEvent.data })
      if (rawEvent.data === "[DONE]") return []
      if (!rawEvent.data) return []

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

      if (chunk.model) st.resolvedModel = chunk.model
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
        st.inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached
        st.outputTokens = chunk.usage.completion_tokens ?? 0
      }

      const events = translateChunkToAnthropicEvents(chunk, st, st.originalModel, {
        filterWhitespaceChunks: deps.filterWhitespaceChunks,
      })

      if (deps.toolCallDebug) {
        const currentToolCallCount = Object.keys(st.toolCalls).length
        if (currentToolCallCount > st.lastToolCallCount) {
          const newToolCall = Object.values(st.toolCalls).reduce((newest, tc) =>
            tc.anthropicBlockIndex > newest.anthropicBlockIndex ? tc : newest,
            { id: "", name: "", anthropicBlockIndex: -1 },
          )
          if (newToolCall.id) {
            logEmitter.emitLog({
              ts: Date.now(), level: "debug", type: "sse_chunk", requestId: ctx.requestId,
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
        st.lastToolCallCount = currentToolCallCount
      }

      return events.map((event) => ({
        event: event.type,
        data: JSON.stringify(event),
      }))
    },

    adaptStreamError: () => {
      const errorEvent = translateErrorToAnthropicErrorEvent()
      return [{
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      }]
    },

    describeEndLog: (result) => {
      if (result.kind === "json") {
        const cached = result.resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
        const inputTokens = (result.resp.usage?.prompt_tokens ?? 0) - cached
        const outputTokens = result.resp.usage?.completion_tokens ?? 0
        return {
          model: result.req.originalModel,
          resolvedModel: result.resp.model,
          translatedModel: result.req.openAIPayload.model,
          inputTokens, outputTokens,
        }
      }
      if (result.kind === "stream") {
        const debugExtras = deps.toolCallDebug
          ? {
            stopReason: "tool_use",
            toolCallCount: Object.keys(result.state.toolCalls).length,
            toolCallNames: Object.values(result.state.toolCalls).map((tc) => tc.name),
          }
          : {}
        return {
          model: result.req.originalModel,
          resolvedModel: result.state.resolvedModel,
          translatedModel: result.req.openAIPayload.model,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          ...debugExtras,
        }
      }
      if (result.kind === "error") {
        return {
          model: result.req.originalModel,
          translatedModel: result.req.openAIPayload.model,
        }
      }
      return {}
    },
  }
}
