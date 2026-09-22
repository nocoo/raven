// ---------------------------------------------------------------------------
// strategies/copilot-translated.ts
//
// Anthropic client ↔ Copilot OpenAI upstream with full bidirectional
// translation. Implements the canonical 7-method `Strategy` interface.
//
// The composition root supplies the upstream client and the per-state knobs
// (`toolCallDebug`). Strategy reads no `infra/state`.
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
  createAnthropicStreamState,
  finalizeAnthropicStream,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "../protocols/translate/stream-translation"

export interface CopilotTranslatedDeps {
  client: CopilotOpenAIClient
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
  cacheReadTokens: number
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

    dispatch: async (up, ctx) => {
      const response = await deps.client.send(up.openAIPayload, ctx.signal)
      if (isOpenAINonStreaming(response)) {
        return { kind: "json", body: response }
      }
      return { kind: "stream", chunks: response }
    },

    adaptJson: (resp, req) => translateToAnthropic(resp, req.originalModel),

    initStreamState: (req) => ({
      ...createAnthropicStreamState(),
      resolvedModel: req.originalModel,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
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
        st.cacheReadTokens = cached
      }

      return emitTranslated(
        translateChunkToAnthropicEvents(chunk, st, st.originalModel),
        ctx, deps.toolCallDebug,
      )
    },

    finalizeStream: (st, ctx) => emitTranslated(finalizeAnthropicStream(st), ctx, deps.toolCallDebug),

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
          cacheReadTokens: cached,
        }
      }
      if (result.kind === "stream") {
        const toolCallCount = Object.keys(result.state.toolCalls).length
        const debugExtras = deps.toolCallDebug
          ? { toolCallNames: Object.values(result.state.toolCalls).map((tc) => tc.name) }
          : {}
        return {
          model: result.req.originalModel,
          resolvedModel: result.state.resolvedModel,
          translatedModel: result.req.openAIPayload.model,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          cacheReadTokens: result.state.cacheReadTokens,
          stopReason: result.state.stopReason,
          toolCallCount,
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

function emitTranslated(
  events: ReturnType<typeof translateChunkToAnthropicEvents>,
  ctx: { requestId: string },
  toolCallDebug: boolean,
): SSEMessage[] {
  if (toolCallDebug) {
    for (const event of events) {
      if (event.type !== "content_block_start" || event.content_block.type !== "tool_use") continue
      logEmitter.emitLog({
        ts: Date.now(), level: "debug", type: "sse_chunk", requestId: ctx.requestId,
        msg: `tool_use started: ${event.content_block.name}`,
        data: {
          eventType: "tool_use_start",
          toolName: event.content_block.name,
          toolId: event.content_block.id,
          blockIndex: event.index,
        },
      })
    }
  }
  return events.map((event) => ({
    event: event.type,
    data: JSON.stringify(event),
  }))
}
