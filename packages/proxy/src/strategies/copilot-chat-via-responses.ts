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
import { mapResponsesFinishReason } from "../protocols/chat-responses/finish-reason"
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
import { extractNonStreamingMeta } from "../protocols/responses/stream-state"

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
        // Runner passes upstream Responses body here (not adaptJson output).
        const meta = extractNonStreamingMeta(
          result.resp,
          result.req.originalChat.model,
        )
        const body =
          result.resp && typeof result.resp === "object"
            ? (result.resp as {
                status?: unknown
                incomplete_details?: { reason?: unknown } | null
                output?: unknown
              })
            : {}
        return {
          model: result.req.originalChat.model,
          resolvedModel: meta.resolvedModel,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          cacheReadTokens: meta.cachedInputTokens,
          routingPath,
          stopReason: mapResponsesFinishReason(body),
        }
      }
      if (result.kind === "stream") {
        return {
          model: result.req.originalChat.model,
          resolvedModel: result.state.model,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          cacheReadTokens: result.state.cacheReadTokens,
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
