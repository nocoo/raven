// ---------------------------------------------------------------------------
// strategies/copilot-responses.ts (H.9)
//
// Promotes `routes/responses/handler.ts::copilotResponsesShim` onto the
// canonical 7-method `Strategy` interface. Pure passthrough — no
// translation. The composition root supplies the upstream client.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import type {
  CopilotResponsesClient,
  ResponsesPayload,
} from "../upstream/copilot-responses"
import {
  extractNonStreamingMeta,
  extractResolvedModel,
  extractUsage,
  isTerminalResponseEvent,
} from "../protocols/responses/stream-state"

export interface CopilotResponsesDeps {
  client: CopilotResponsesClient
}

export interface CopilotResponsesStreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}

export function makeCopilotResponses(deps: CopilotResponsesDeps): Strategy<
  ResponsesPayload,
  ResponsesPayload,
  unknown,
  unknown,
  ServerSentEvent,
  SSEMessage,
  CopilotResponsesStreamState
> {
  return {
    name: "copilot-responses",

    prepare: (req) => req,

    dispatch: async (up) => {
      const response = await deps.client.send(up)
      if (up.stream && isAsyncIterable<ServerSentEvent>(response)) {
        return { kind: "stream", chunks: response }
      }
      return { kind: "json", body: response }
    },

    adaptJson: (resp) => resp,

    initStreamState: (req) => ({
      resolvedModel: req.model,
      inputTokens: 0,
      outputTokens: 0,
    }),

    adaptChunk: (chunk, st, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: chunk.event, data: chunk.data })

      if (chunk.event === "response.created") {
        const m = extractResolvedModel(chunk.data)
        if (m) st.resolvedModel = m
      }

      if (isTerminalResponseEvent(chunk.event)) {
        const usage = extractUsage(chunk.data)
        if (usage) {
          st.inputTokens = usage.inputTokens
          st.outputTokens = usage.outputTokens
        }
      }

      const sseMsg: SSEMessage = { data: chunk.data }
      if (chunk.event) sseMsg.event = chunk.event
      if (chunk.id) sseMsg.id = chunk.id
      if (chunk.retry !== null) sseMsg.retry = chunk.retry
      return [sseMsg]
    },

    adaptStreamError: () => [{
      event: "error",
      data: JSON.stringify({
        error: {
          type: "server_error",
          code: "stream_error",
          message: "An upstream error occurred during streaming.",
        },
      }),
    }],

    describeEndLog: (result) => {
      if (result.kind === "json") {
        const meta = extractNonStreamingMeta(result.resp, result.req.model)
        return {
          model: result.req.model,
          resolvedModel: meta.resolvedModel,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
        }
      }
      if (result.kind === "stream") {
        return {
          model: result.req.model,
          resolvedModel: result.state.resolvedModel,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
        }
      }
      if (result.kind === "error") {
        return {
          model: result.req.model,
        }
      }
      return {}
    },
  }
}
