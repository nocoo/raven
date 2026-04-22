import type { Context } from "hono"
import type { SSEMessage } from "hono/streaming"

import { buildUpstreamClient } from "../../composition/upstream-registry"
import { pickStrategy } from "../../core/router"
import { respondRouterReject } from "../../core/router-reject"
import { execute as runnerExecute } from "../../core/runner"
import type { RequestContext as RunnerCtx } from "../../core/context"
import type { Strategy } from "../../core/strategy"
import type { ResponsesPayload } from "../../upstream/copilot-responses"
import { forwardError } from "../../lib/error"
import { checkRateLimit } from "../../lib/rate-limit"
import { state } from "../../lib/state"
import type { ServerSentEvent } from "../../util/sse"
import { logEmitter } from "../../util/log-emitter"
import { emitUpstreamRawSse } from "../../util/emit-upstream-raw"
import { generateRequestId } from "../../util/id"
import { deriveClientIdentity } from "../../util/client-identity"
import {
  extractNonStreamingMeta,
  extractResolvedModel,
  extractUsage,
  isTerminalResponseEvent,
} from "../../protocols/responses/stream-state"

export const handleResponses = async (c: Context) => {
  const startTime = performance.now()
  const requestId = generateRequestId()

  let payload: ResponsesPayload

  try {
    await checkRateLimit(state)
  } catch (error) {
    // Rate limit error — forward with proper status
    return forwardError(c, error)
  }

  try {
    payload = await c.req.json<ResponsesPayload>()
  } catch {
    return c.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, 400)
  }

  const model = payload.model
  const stream = !!payload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(null, userAgent, accountName, null)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/responses ${model}`,
    data: { path: "/v1/responses", format: "responses", model, stream, accountName, sessionId, clientName, clientVersion },
  })

  const decision = pickStrategy({
    protocol: "responses",
    model,
    providers: state.providers,
    modelsCatalogIds: state.models?.data?.map((m) => m.id) ?? [],
  })

  if (decision.kind === "reject") {
    return respondRouterReject(c, decision, {
      requestId, startTime,
      path: "/v1/responses", format: "responses",
      model, stream,
      accountName, sessionId, clientName, clientVersion,
    })
  }

  // decision.name === "copilot-responses" — route through Runner.
  const runnerCtx: RunnerCtx = {
    requestId, startTime, format: "responses", path: "/v1/responses",
    stream,
    accountName, userAgent, anthropicBeta: null,
    sessionId, clientName, clientVersion,
  }
  try {
    return await runnerExecute(c, runnerCtx, copilotResponsesShim, payload)
  } catch (error) {
    return forwardError(c, error)
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}

// ===========================================================================
// G.12: Strategy shim — copilot-responses (passthrough). Local to this file;
// promoted in Phase H.
// ===========================================================================

interface CopilotResponsesStreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
}

const copilotResponsesShim: Strategy<
  ResponsesPayload,
  ResponsesPayload,
  unknown,
  unknown,
  ServerSentEvent,
  SSEMessage,
  CopilotResponsesStreamState
> = {
  name: "copilot-responses",

  prepare: (req) => req,

  dispatch: async (up) => {
    const response = await buildUpstreamClient("copilot-responses").send(up)
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
