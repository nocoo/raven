// ---------------------------------------------------------------------------
// strategies/custom-openai.ts
//
// Serves both entry points (chat-completions passthrough + messages
// Anthropic-translated) as a single Strategy. Mode is selected per-request
// via the optional `originalModel` field:
//   - present → translate response/stream OpenAI → Anthropic
//   - absent  → passthrough OpenAI bytes
//
// The composition root supplies the upstream client. Strategy reads no
// `infra/state`; tool-call debug + filter flags arrive via factory deps.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import { logEmitter } from "../util/log-emitter"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import type { CompiledProvider } from "../db/providers"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../upstream/copilot-openai"
import type { CustomOpenAIClient } from "../upstream/custom-openai"
import type { AnthropicStreamState } from "../protocols/anthropic/types"
import {
  translateToAnthropic,
} from "../protocols/translate/non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "../protocols/translate/stream-translation"

export interface CustomOpenAIDeps {
  client: CustomOpenAIClient
  /** Forwarded to translateChunkToAnthropicEvents in translated mode. */
  filterWhitespaceChunks: boolean
  /** When true, emit `tool_use_start` debug events as new tool calls arrive. */
  toolCallDebug: boolean
}

export interface CustomOpenAIUpReq {
  provider: CompiledProvider
  /** Already-translated OpenAI payload sent upstream. */
  payload: ChatCompletionsPayload
  /**
   * Optional Anthropic-side model name. When set, the strategy translates
   * the upstream OpenAI response/stream back to Anthropic shape.
   */
  originalModel?: string
}

export interface CustomOpenAIStreamState extends AnthropicStreamState {
  /** Mirrors `req.payload.model` so error logs survive without `req`. */
  model: string
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  upstream: string
  upstreamFormat: string
  /** Set ⇔ translated mode. */
  originalModel: string | undefined
  /** Translated mode only. */
  lastToolCallCount: number
}

const isOpenAINonStreaming = (
  response: ChatCompletionResponse | AsyncGenerator<ServerSentEvent>,
): response is ChatCompletionResponse =>
  typeof response === "object" && "object" in response && response.object === "chat.completion"

export function makeCustomOpenAI(deps: CustomOpenAIDeps): Strategy<
  CustomOpenAIUpReq,
  CustomOpenAIUpReq,
  ChatCompletionResponse,
  unknown,
  ServerSentEvent,
  SSEMessage,
  CustomOpenAIStreamState
> {
  return {
    name: "custom-openai",

    prepare: (req) => req,

    dispatch: async (up) => {
      const response = await deps.client.send({
        provider: up.provider,
        payload: up.payload,
      })
      if (isOpenAINonStreaming(response)) {
        return { kind: "json", body: response }
      }
      return { kind: "stream", chunks: response }
    },

    adaptJson: (resp, req) => {
      if (req.originalModel) {
        return translateToAnthropic(resp, req.originalModel)
      }
      return resp
    },

    initStreamState: (req) => ({
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      model: req.payload.model,
      resolvedModel: req.originalModel ?? req.payload.model,
      inputTokens: 0,
      outputTokens: 0,
      upstream: req.provider.name,
      upstreamFormat: req.provider.format,
      originalModel: req.originalModel,
      lastToolCallCount: 0,
    }),

    adaptChunk: (rawEvent, st, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: rawEvent.event, data: rawEvent.data })

      if (rawEvent.data === "[DONE]") {
        return st.originalModel ? [] : [rawEvent as SSEMessage]
      }
      if (!rawEvent.data) return st.originalModel ? [] : [rawEvent as SSEMessage]

      let chunk: ChatCompletionChunk
      if (st.originalModel) {
        // Translated mode: a malformed chunk corrupts the Anthropic stream
        // bookkeeping (block index, usage). Let it propagate so Runner
        // surfaces an error event to the client and marks request_end as
        // failed. Passthrough mode below tolerates parse failures because
        // the bytes are forwarded verbatim regardless.
        chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      } else {
        try {
          chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        } catch {
          return [rawEvent as SSEMessage]
        }
      }

      if (chunk.model) st.resolvedModel = chunk.model
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
        st.inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached
        st.outputTokens = chunk.usage.completion_tokens ?? 0
      }

      if (st.originalModel) {
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
      }

      return [rawEvent as SSEMessage]
    },

    adaptStreamError: (_err, st) => {
      if (st.originalModel) {
        const errorEvent = translateErrorToAnthropicErrorEvent()
        return [{
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        }]
      }
      return [{
        data: JSON.stringify({
          error: {
            message: "An upstream error occurred during streaming.",
            type: "server_error",
            code: "stream_error",
          },
        }),
      }]
    },

    describeEndLog: (result) => {
      if (result.kind === "json") {
        const cached = result.resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
        const inputTokens = (result.resp.usage?.prompt_tokens ?? 0) - cached
        const outputTokens = result.resp.usage?.completion_tokens ?? 0
        if (result.req.originalModel) {
          return {
            model: result.req.originalModel,
            resolvedModel: result.resp.model,
            translatedModel: result.req.payload.model,
            inputTokens, outputTokens,
            upstream: result.req.provider.name,
            upstreamFormat: result.req.provider.format,
          }
        }
        return {
          model: result.resp.model,
          resolvedModel: result.resp.model,
          inputTokens, outputTokens,
          upstream: result.req.provider.name,
          upstreamFormat: result.req.provider.format,
        }
      }
      if (result.kind === "stream") {
        const toolCallCount = Object.keys(result.state.toolCalls).length
        const debugExtras = deps.toolCallDebug
          ? { toolCallNames: Object.values(result.state.toolCalls).map((tc) => tc.name) }
          : {}
        if (result.state.originalModel) {
          return {
            model: result.state.originalModel,
            resolvedModel: result.state.resolvedModel,
            translatedModel: result.state.model,
            inputTokens: result.state.inputTokens,
            outputTokens: result.state.outputTokens,
            upstream: result.state.upstream,
            upstreamFormat: result.state.upstreamFormat,
            stopReason: toolCallCount > 0 ? "tool_use" : "end_turn",
            toolCallCount,
            ...debugExtras,
          }
        }
        return {
          model: result.state.model,
          resolvedModel: result.state.resolvedModel,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          upstream: result.state.upstream,
          upstreamFormat: result.state.upstreamFormat,
          stopReason: toolCallCount > 0 ? "tool_use" : "end_turn",
          toolCallCount,
          ...debugExtras,
        }
      }
      if (result.kind === "error") {
        if (result.req.originalModel) {
          return {
            model: result.req.originalModel,
            translatedModel: result.req.payload.model,
            upstream: result.req.provider.name,
            upstreamFormat: result.req.provider.format,
          }
        }
        return {
          model: result.req.payload.model,
          upstream: result.req.provider.name,
          upstreamFormat: result.req.provider.format,
        }
      }
      return {}
    },
  }
}
