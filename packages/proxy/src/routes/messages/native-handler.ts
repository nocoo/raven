/**
 * Native Copilot Anthropic messages handler — server-tools branch only.
 *
 * H.8: The default (no server-tools) native path moved to the
 * `copilot-native` strategy via `composition.dispatch`. This file now
 * exists solely to handle the server-side tools sub-branch (web_search),
 * which runs its own request loop via `withServerToolInterception` and
 * stays in the route until Phase I.
 */

import type { Context } from "hono"

import { state } from "../../lib/state"
import { logEmitter } from "../../util/log-emitter"
import { extractErrorDetails, forwardError, HTTPError } from "../../lib/error"
import { buildUpstreamClient } from "../../composition/upstream-registry"
import type { NativeMessagesOptions } from "../../upstream/copilot-native"
import type { ServerSentEvent } from "../../util/sse"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../../protocols/anthropic/types"
import type { ServerToolContext } from "../../protocols/anthropic/preprocess"
import { withServerToolInterception } from "../../strategies/support/server-tools"
import { streamAnthropicResponse } from "../../strategies/support/anthropic-stream-writer"
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

/**
 * Handle a native /v1/messages request that uses server-side tools.
 * Server-tool interception runs non-streaming internally; if the client
 * requested streaming we replay the resolved response as SSE.
 */
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
    const sendNonStreamingRequest = createSendNonStreamingRequest(nativeOptions, requestId)
    const response = await withServerToolInterception(
      payload,
      serverToolContext,
      sendNonStreamingRequest,
      requestId,
    )

    const latencyMs = Math.round(performance.now() - startTime)
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "request_end",
      requestId,
      msg: `200 ${originalModel} ${latencyMs}ms (native+server-tools)`,
      data: {
        path: "/v1/messages",
        format: "anthropic",
        model: originalModel,
        resolvedModel: response.model,
        copilotModel,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        latencyMs,
        ttftMs: null,
        processingMs: null,
        stream: false,
        status: "success",
        statusCode: 200,
        upstreamStatus: 200,
        routingPath: "native",
        serverToolsUsed: true,
        accountName,
        sessionId,
        clientName,
        clientVersion,
      },
    })

    if (stream) {
      return streamAnthropicResponse(c, response)
    }
    return c.json(response)
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

    logEmitter.emitLog({
      ts: Date.now(),
      level: "error",
      type: "request_end",
      requestId,
      msg: `${statusCode} ${originalModel} ${latencyMs}ms (native)`,
      data: {
        path: "/v1/messages",
        format: "anthropic",
        model: originalModel,
        copilotModel,
        stream,
        latencyMs,
        status: "error",
        statusCode,
        upstreamStatus,
        error: errorDetail,
        routingPath: "native",
        accountName,
        sessionId,
        clientName,
        clientVersion,
      },
    })
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
