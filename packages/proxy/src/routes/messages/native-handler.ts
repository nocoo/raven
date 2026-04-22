/**
 * Native Copilot Anthropic messages handler — server-tools branch only.
 *
 * I.3: rewritten to use `decorate()`; the request_end log + stream-replay
 * logic is now shared with the translated path. Only the native-specific
 * sendRequest closure (payload → copilot-native client, with effort
 * fallback) lives here. The file itself is slated for deletion in J.1
 * once the effort-fallback helper moves next to the strategy.
 */

import type { Context } from "hono"

import { state } from "../../lib/state"
import { logEmitter } from "../../util/log-emitter"
import { forwardError, HTTPError } from "../../lib/error"
import { buildUpstreamClient } from "../../composition/upstream-registry"
import type { NativeMessagesOptions } from "../../upstream/copilot-native"
import type { ServerSentEvent } from "../../util/sse"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../protocols/anthropic/types"
import type { ServerToolContext } from "../../protocols/anthropic/preprocess"
import { decorate as decorateServerTools } from "../../strategies/support/server-tools"
import {
  parseReasoningEffortError,
  pickSupportedEffort,
  adjustEffortInPayload,
  logEffortFallback,
} from "../../strategies/support/effort-fallback"

interface RequestContext {
  accountName: string
  sessionId: string
  clientName: string | null
  clientVersion: string | null
}

export async function handleCopilotNativeServerTools(
  c: Context,
  requestId: string,
  payload: AnthropicMessagesPayload,
  startTime: number,
  copilotModel: string,
  anthropicBeta: string | null,
  serverToolContext: ServerToolContext,
  ctx: RequestContext,
): Promise<Response> {
  const { accountName, sessionId, clientName, clientVersion } = ctx
  const originalModel = payload.model
  const stream = !!payload.stream

  const nativeOptions: NativeMessagesOptions = { copilotModel, anthropicBeta }

  if (state.optToolCallDebug) {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "debug",
      type: "request_start",
      requestId,
      msg: `native path: server-tool check: hasServerSideTools=true, webSearchEnabled=true`,
      data: {
        hasServerSideTools: serverToolContext.hasServerSideTools,
        webSearchEnabled: true,
        serverSideToolNames: serverToolContext.serverSideToolNames,
        allServerSide: serverToolContext.allServerSide,
      },
    })
  }

  try {
    return await decorateServerTools({
      c, requestId, startTime, stream, model: originalModel,
      payload,
      serverToolContext,
      sendRequest: createSendNonStreamingRequest(nativeOptions, requestId),
      log: {
        path: "/v1/messages", format: "anthropic",
        accountName, sessionId, clientName, clientVersion,
        extras: { copilotModel, routingPath: "native" },
      },
    })
  } catch (error) {
    return forwardError(c, error)
  }
}

async function sendWithEffortFallback(
  payload: AnthropicMessagesPayload,
  options: NativeMessagesOptions,
  requestId: string,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  try {
    return await buildUpstreamClient("copilot-native").send({ payload, options })
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
    logEffortFallback(requestId, options.copilotModel, effortError.requestedEffort, fallbackEffort)
    const adjustedPayload = adjustEffortInPayload(payload, fallbackEffort)
    return await buildUpstreamClient("copilot-native").send({ payload: adjustedPayload, options })
  }
}

function createSendNonStreamingRequest(
  nativeOptions: NativeMessagesOptions,
  requestId: string,
): (p: AnthropicMessagesPayload) => Promise<AnthropicResponse> {
  return async (p: AnthropicMessagesPayload): Promise<AnthropicResponse> => {
    const nonStreamPayload: AnthropicMessagesPayload = { ...p, stream: false }
    const result = await sendWithEffortFallback(nonStreamPayload, nativeOptions, requestId)
    return result as AnthropicResponse
  }
}
