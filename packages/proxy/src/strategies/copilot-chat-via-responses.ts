// ---------------------------------------------------------------------------
// strategies/copilot-chat-via-responses.ts
//
// Chat Completions client → Copilot /responses upstream with full translation.
// Local rejects (n/stop) throw ClientInputError from dispatch (Runner try).
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { ChatCompletionResponse } from "../upstream/copilot-openai"
import type { CopilotResponsesClient } from "../upstream/copilot-responses"
import type { ServerSentEvent } from "../util/sse"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import {
  assertChatViaResponsesSupported,
  chatRequestToResponses,
} from "../protocols/chat-responses/request"
import {
  ResponsesProtocolError,
  responsesJsonToChatCompletion,
} from "../protocols/chat-responses/response"
import {
  ResponsesStreamFailedError,
  adaptResponsesEventToChatChunks,
  initChatViaResponsesStreamState,
} from "../protocols/chat-responses/stream"
import type {
  ChatViaResponsesClientReq,
  ChatViaResponsesStreamState,
  ChatViaResponsesUpReq,
} from "../protocols/chat-responses/types"

export interface CopilotChatViaResponsesDeps {
  client: CopilotResponsesClient
  toolCallDebug: boolean
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}

export function makeCopilotChatViaResponses(
  deps: CopilotChatViaResponsesDeps,
): Strategy<
  ChatViaResponsesClientReq,
  ChatViaResponsesUpReq,
  unknown,
  ChatCompletionResponse,
  ServerSentEvent,
  SSEMessage,
  ChatViaResponsesStreamState
> {
  return {
    name: "copilot-chat-via-responses",

    prepare: (req) => {
      const includeUsage = !!req.stream_options?.include_usage
      const responsesPayload = chatRequestToResponses(req)
      // Belt-and-suspenders: never leak local fields
      delete (responsesPayload as { stream_options?: unknown }).stream_options
      delete (responsesPayload as { includeUsage?: unknown }).includeUsage
      return {
        originalChat: req,
        includeUsage,
        responsesPayload,
      }
    },

    dispatch: async (up) => {
      assertChatViaResponsesSupported(up.originalChat)
      const response = await deps.client.send(up.responsesPayload)
      if (up.responsesPayload.stream && isAsyncIterable<ServerSentEvent>(response)) {
        return { kind: "stream", chunks: response }
      }
      return { kind: "json", body: response }
    },

    adaptJson: (resp, req) =>
      responsesJsonToChatCompletion(resp, req.originalChat.model),

    initStreamState: (req) =>
      initChatViaResponsesStreamState({
        model: req.originalChat.model,
        includeUsage: req.includeUsage,
      }),

    adaptChunk: (chunk, st, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: chunk.event, data: chunk.data })
      return adaptResponsesEventToChatChunks(chunk, st)
    },

    adaptStreamError: (err) => {
      const message =
        err instanceof ResponsesStreamFailedError ||
        err instanceof ResponsesProtocolError ||
        err instanceof Error
          ? err.message
          : "An upstream error occurred during streaming."
      return [
        {
          data: JSON.stringify({
            error: {
              message,
              type: "server_error",
              code: "stream_error",
            },
          }),
        },
      ]
    },

    describeEndLog: (result) => {
      const routingPath = "chat-via-responses"
      if (result.kind === "json") {
        const resp = result.resp as ChatCompletionResponse
        const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
        const inputTokens = (resp.usage?.prompt_tokens ?? 0) - cached
        const outputTokens = resp.usage?.completion_tokens ?? 0
        return {
          model: result.req.originalChat.model,
          resolvedModel: resp.model,
          inputTokens,
          outputTokens,
          routingPath,
          stopReason: resp.choices?.[0]?.finish_reason ?? null,
        }
      }
      if (result.kind === "stream") {
        return {
          model: result.req.originalChat.model,
          resolvedModel: result.state.model,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          routingPath,
          stopReason: result.state.finishReason,
        }
      }
      if (result.kind === "error") {
        return {
          model: result.req.originalChat.model,
          routingPath,
        }
      }
      return { routingPath }
    },
  }
}
