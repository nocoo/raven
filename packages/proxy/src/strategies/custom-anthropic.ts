// ---------------------------------------------------------------------------
// strategies/custom-anthropic.ts
//
// Promotes the Phase-G `customAnthropicShim` from
// `routes/messages/handler.ts` onto the canonical 7-method `Strategy`
// interface. Pure passthrough — no translation. Only token usage is
// extracted from `message_delta` events for end logging.
//
// The composition root supplies the upstream client. Strategy reads no
// `infra/state`.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import type { CompiledProvider } from "../db/providers"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../protocols/anthropic/types"
import { translateErrorToAnthropicErrorEvent } from "../protocols/translate/stream-translation"
import type { CustomAnthropicClient } from "../upstream/custom-anthropic"

export interface CustomAnthropicDeps {
  client: CustomAnthropicClient
}

export interface CustomAnthropicUpReq {
  provider: CompiledProvider
  payload: AnthropicMessagesPayload
}

export interface CustomAnthropicStreamState {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const isAnthropicNonStreaming = (
  response: AnthropicResponse | AsyncGenerator<ServerSentEvent>,
): response is AnthropicResponse =>
  typeof response === "object" && "type" in response && response.type === "message"

export function makeCustomAnthropic(deps: CustomAnthropicDeps): Strategy<
  CustomAnthropicUpReq,
  CustomAnthropicUpReq,
  AnthropicResponse,
  AnthropicResponse,
  ServerSentEvent,
  SSEMessage,
  CustomAnthropicStreamState
> {
  return {
    name: "custom-anthropic",

    prepare: (req) => req,

    dispatch: async (up) => {
      const response = await deps.client.send(up)
      if (isAnthropicNonStreaming(response)) {
        return { kind: "json", body: response }
      }
      return { kind: "stream", chunks: response }
    },

    adaptJson: (resp) => resp,

    initStreamState: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),

    adaptChunk: (sseEvent, st) => {
      try {
        type Usage = {
          input_tokens?: number | null
          output_tokens?: number | null
          cache_read_input_tokens?: number | null
          cache_creation_input_tokens?: number | null
        }
        const parsed = JSON.parse(sseEvent.data) as {
          type?: string
          message?: { usage?: Usage }
          usage?: Usage
        }
        // message_start carries input + cache counters; message_delta carries
        // output totals and usually omits input_tokens — keep the prior value
        // rather than zeroing it.
        if (parsed.type === "message_start" && parsed.message?.usage) {
          st.inputTokens = parsed.message.usage.input_tokens ?? st.inputTokens
          st.cacheReadTokens = parsed.message.usage.cache_read_input_tokens ?? 0
          st.cacheWriteTokens = parsed.message.usage.cache_creation_input_tokens ?? 0
        }
        if (parsed.type === "message_delta" && parsed.usage) {
          st.inputTokens = parsed.usage.input_tokens ?? st.inputTokens
          st.outputTokens = parsed.usage.output_tokens ?? st.outputTokens
        }
      } catch {
        // Ignore parse errors for metrics
      }

      if (sseEvent.event) {
        return [{ event: sseEvent.event, data: sseEvent.data }]
      }
      return [{ data: sseEvent.data }]
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
        return {
          model: result.req.payload.model,
          resolvedModel: result.req.payload.model,
          inputTokens: result.resp.usage?.input_tokens ?? 0,
          outputTokens: result.resp.usage?.output_tokens ?? 0,
          cacheReadTokens: result.resp.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: result.resp.usage?.cache_creation_input_tokens ?? 0,
          upstream: result.req.provider.name,
          upstreamFormat: result.req.provider.format,
        }
      }
      if (result.kind === "stream") {
        return {
          model: result.req.payload.model,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          cacheReadTokens: result.state.cacheReadTokens,
          cacheWriteTokens: result.state.cacheWriteTokens,
          upstream: result.req.provider.name,
          upstreamFormat: result.req.provider.format,
        }
      }
      if (result.kind === "error") {
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
