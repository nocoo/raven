// ---------------------------------------------------------------------------
// strategies/copilot-native.ts (H.7)
//
// Lifts the default (no server-tools) branch of the native /v1/messages
// handler onto the canonical 7-method Strategy interface. Encapsulates the
// effort-fallback retry inside `dispatch` so the route doesn't need to know
// about it. The server-tools sub-branch stays in the route until Phase I.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import type { ServerSentEvent } from "../util/sse"
import { HTTPError } from "../lib/error"
import type {
  CopilotNativeClient,
  NativeMessagesOptions,
} from "../upstream/copilot-native"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../protocols/anthropic/types"
import {
  parseReasoningEffortError,
  pickSupportedEffort,
  adjustEffortInPayload,
  logEffortFallback,
} from "./support/effort-fallback"
import { translateErrorToAnthropicErrorEvent } from "../protocols/translate/stream-translation"

export interface CopilotNativeDeps {
  client: CopilotNativeClient
}

export interface CopilotNativeUpReq {
  payload: AnthropicMessagesPayload
  options: NativeMessagesOptions
  /** Original Anthropic-side model name (used in logs). */
  originalModel: string
}

export interface CopilotNativeStreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  copilotModel: string
  originalModel: string
}

const isAsyncGenerator = (
  response: AnthropicResponse | AsyncGenerator<ServerSentEvent>,
): response is AsyncGenerator<ServerSentEvent> =>
  typeof (response as AsyncGenerator).next === "function"

export function makeCopilotNative(deps: CopilotNativeDeps): Strategy<
  CopilotNativeUpReq,
  CopilotNativeUpReq,
  AnthropicResponse,
  AnthropicResponse,
  ServerSentEvent,
  SSEMessage,
  CopilotNativeStreamState
> {
  return {
    name: "copilot-native",

    prepare: (req) => req,

    dispatch: async (up, ctx) => {
      const response = await sendWithEffortFallback(deps.client, up, ctx.requestId)
      if (isAsyncGenerator(response)) {
        return { kind: "stream", chunks: response }
      }
      return { kind: "json", body: response }
    },

    adaptJson: (resp) => resp,

    initStreamState: (req) => ({
      resolvedModel: req.options.copilotModel,
      inputTokens: 0,
      outputTokens: 0,
      copilotModel: req.options.copilotModel,
      originalModel: req.originalModel,
    }),

    adaptChunk: (sseEvent, st, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: sseEvent.event, data: sseEvent.data })

      if (sseEvent.data) {
        try {
          const parsed = JSON.parse(sseEvent.data)
          if (parsed.type === "message_start" && parsed.message?.model) {
            st.resolvedModel = parsed.message.model
          }
          if (parsed.type === "message_start" && parsed.message?.usage) {
            st.inputTokens = parsed.message.usage.input_tokens ?? 0
          }
          if (parsed.type === "message_delta" && parsed.usage) {
            st.outputTokens = parsed.usage.output_tokens ?? 0
          }
        } catch {
          // Parse error for metrics — don't break stream
        }
      }

      const out: SSEMessage = { data: sseEvent.data }
      if (sseEvent.event) out.event = sseEvent.event
      return [out]
    },

    adaptStreamError: () => {
      // Native handler emits a synthesised generic error event (not the
      // translate helper) — match its exact shape so end-to-end bytes are
      // identical to the legacy path.
      return [
        {
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Upstream stream error" },
          }),
        },
      ]
    },

    describeEndLog: (result) => {
      if (result.kind === "json") {
        return {
          model: result.req.originalModel,
          resolvedModel: result.resp.model,
          copilotModel: result.req.options.copilotModel,
          inputTokens: result.resp.usage?.input_tokens ?? 0,
          outputTokens: result.resp.usage?.output_tokens ?? 0,
          routingPath: "native",
        }
      }
      if (result.kind === "stream") {
        return {
          model: result.req.originalModel,
          resolvedModel: result.state.resolvedModel,
          copilotModel: result.state.copilotModel,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          routingPath: "native",
        }
      }
      // error arm
      return {
        model: result.req.originalModel,
        copilotModel: result.req.options.copilotModel,
        routingPath: "native",
      }
    },
  }
}

async function sendWithEffortFallback(
  client: CopilotNativeClient,
  req: CopilotNativeUpReq,
  requestId: string,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  try {
    return await client.send({ payload: req.payload, options: req.options })
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error
    if (error.status !== 400) throw error
    let errorBody: unknown
    try {
      errorBody = JSON.parse(error.responseBody)
    } catch {
      throw error
    }
    const effortError = parseReasoningEffortError(errorBody)
    if (!effortError) throw error
    const fallbackEffort = pickSupportedEffort(
      effortError.requestedEffort,
      effortError.supportedEfforts,
    )
    logEffortFallback(requestId, req.options.copilotModel, effortError.requestedEffort, fallbackEffort)
    const adjustedPayload = adjustEffortInPayload(req.payload, fallbackEffort)
    return await client.send({ payload: adjustedPayload, options: req.options })
  }
}

// Keep the import referenced — translate helper is still useful if a future
// caller wants Anthropic-shaped error events; for now adaptStreamError emits
// the legacy native shape directly.
void translateErrorToAnthropicErrorEvent
