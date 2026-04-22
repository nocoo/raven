import type { Context } from "hono"

import { type SSEMessage } from "hono/streaming"

import { checkRateLimit } from "./../../lib/rate-limit"
import { state } from "./../../lib/state"
import { resolveProvider } from "./../../lib/upstream-router"
import { pickStrategy } from "./../../core/router"
import { respondRouterReject } from "./../../core/router-reject"
import { execute as runnerExecute } from "./../../core/runner"
import type { RequestContext as RunnerCtx } from "./../../core/context"
import type { Strategy } from "./../../core/strategy"
import type { CompiledProvider } from "./../../db/providers"
import { isNullish } from "./../../lib/utils"
import { logEmitter } from "./../../util/log-emitter"
import { emitUpstreamRawSse } from "./../../util/emit-upstream-raw"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"
import { buildUpstreamClient } from "./../../composition/upstream-registry"
import { dispatch as compositionDispatch } from "./../../composition"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "./../../upstream/copilot-openai"
import type { ServerSentEvent } from "./../../util/sse"
import { forwardError } from "./../../lib/error"

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateRequestId()

  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  const model = payload.model
  const stream = !!payload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const openaiUser = payload.user ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(null, userAgent, accountName, openaiUser)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/chat/completions ${model}`,
    data: { path: "/v1/chat/completions", format: "openai", model, stream, accountName, sessionId, clientName, clientVersion },
  })

  // Debug: log tool definitions
  if (state.optToolCallDebug && payload.tools) {
    logEmitter.emitLog({
      ts: Date.now(), level: "debug", type: "request_start", requestId,
      msg: `tool definitions: ${payload.tools.length}`,
      data: {
        toolDefinitions: payload.tools.map((t: { function: { name: string } }) => t.function.name),
        toolDefinitionCount: payload.tools.length,
      },
    })
  }

  // Prefer max_completion_tokens for newer OpenAI models and keep outbound
  // chat/completions payloads on a single canonical token limit field.
  payload = normalizeTokenLimitParams(payload)

  const decision = pickStrategy({
    protocol: "openai",
    model,
    providers: state.providers,
    modelsCatalogIds: state.models?.data?.map((m) => m.id) ?? [],
  })

  if (decision.kind === "ok" && decision.name === "custom-openai") {
    const resolved = resolveProvider(model)
    if (!resolved) throw new Error(`router/handler drift: no provider for ${model}`)
    const runnerCtx: RunnerCtx = {
      requestId, startTime, format: "openai", path: "/v1/chat/completions",
      stream,
      accountName, userAgent, anthropicBeta: null,
      sessionId, clientName, clientVersion,
    }
    try {
      return await runnerExecute(c, runnerCtx, customOpenAIShim, { provider: resolved.provider, payload })
    } catch (error) {
      return forwardError(c, error)
    }
  }

  if (decision.kind === "reject") {
    const resolved = resolveProvider(model)
    const provider = resolved?.provider
    return respondRouterReject(c, decision, {
      requestId, startTime,
      path: "/v1/chat/completions", format: "openai",
      model, stream,
      accountName, sessionId, clientName, clientVersion,
      ...(provider ? { upstream: provider.name, upstreamFormat: provider.format } : {}),
    })
  }

  // decision.name === "copilot-openai-direct"
  // Find the selected model
  const selectedModel = state.models?.data.find(
    (m) => m.id === payload.model,
  )

  if (isNullish(payload.max_completion_tokens)) {
    const maxOutputTokens = selectedModel?.capabilities.limits.max_output_tokens
    if (!isNullish(maxOutputTokens)) {
      payload = {
        ...payload,
        max_completion_tokens: maxOutputTokens,
      }
    }
  }

  // H.5: copilot-openai-direct now flows through composition.dispatch.
  // Runner owns success+error logs end-to-end via the strategy registered
  // in composition/strategy-registry.ts. The reject branch above is kept
  // because it carries the resolved provider name as upstream tags — once
  // every route is on dispatch, that branch will be inlined into composition.
  const runnerCtx: RunnerCtx = {
    requestId, startTime, format: "openai", path: "/v1/chat/completions",
    stream,
    accountName, userAgent, anthropicBeta: null,
    sessionId, clientName, clientVersion,
  }
  try {
    return await compositionDispatch(c, runnerCtx, payload, "openai", {
      model,
      stream,
      anthropicBeta: null,
      providers: state.providers,
      models: state.models?.data ?? [],
      buildDeps: { toolCallDebug: state.optToolCallDebug },
    })
  } catch (error) {
    // Runner already emitted request_end (error). Match legacy behaviour
    // by surfacing through forwardError so the client gets a JSON body.
    return forwardError(c, error)
  }
}

function normalizeTokenLimitParams(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  if (!isNullish(payload.max_completion_tokens)) {
    if (isNullish(payload.max_tokens)) return payload
    const { max_tokens: _, ...rest } = payload
    return rest
  }

  if (isNullish(payload.max_tokens)) {
    return payload
  }

  const { max_tokens, ...rest } = payload
  return {
    ...rest,
    max_completion_tokens: max_tokens,
  }
}

// ===========================================================================
// G.8: Strategy shim — custom-openai (passthrough). Local to this file; the
// real `strategies/custom-openai.ts` lands in Phase H.
// ===========================================================================

interface CustomOpenAIUpReq {
  provider: CompiledProvider
  payload: ChatCompletionsPayload
}

interface CustomOpenAIStreamState {
  model: string
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  upstream: string
  upstreamFormat: string
}

const customOpenAIShim: Strategy<
  CustomOpenAIUpReq,
  CustomOpenAIUpReq,
  ChatCompletionResponse,
  ChatCompletionResponse,
  ServerSentEvent,
  SSEMessage,
  CustomOpenAIStreamState
> = {
  name: "custom-openai",

  prepare: (req) => req,

  dispatch: async (up) => {
    const response = await buildUpstreamClient("custom-openai").send(up)
    if (isOpenAINonStreaming(response)) {
      return { kind: "json", body: response }
    }
    return { kind: "stream", chunks: response }
  },

  adaptJson: (resp) => resp,

  initStreamState: (req) => ({
    model: req.payload.model,
    resolvedModel: req.payload.model,
    inputTokens: 0,
    outputTokens: 0,
    upstream: req.provider.name,
    upstreamFormat: req.provider.format,
  }),

  adaptChunk: (chunk, st, ctx) => {
    emitUpstreamRawSse(ctx.requestId, { event: chunk.event, data: chunk.data })

    if (chunk.data && chunk.data !== "[DONE]") {
      try {
        const parsed = JSON.parse(chunk.data)
        if (parsed.model) st.resolvedModel = parsed.model
        if (parsed.usage) {
          const cached = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
          st.inputTokens = (parsed.usage.prompt_tokens ?? 0) - cached
          st.outputTokens = parsed.usage.completion_tokens ?? 0
        }
      } catch {
        // Parse error for metrics — don't break stream
      }
    }

    return [chunk as SSEMessage]
  },

  adaptStreamError: () => [
    {
      data: JSON.stringify({
        error: {
          message: "An upstream error occurred during streaming.",
          type: "server_error",
          code: "stream_error",
        },
      }),
    },
  ],

  describeEndLog: (result) => {
    if (result.kind === "json") {
      const cached = result.resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (result.resp.usage?.prompt_tokens ?? 0) - cached
      const outputTokens = result.resp.usage?.completion_tokens ?? 0
      return {
        model: result.resp.model,
        resolvedModel: result.resp.model,
        inputTokens,
        outputTokens,
        upstream: result.req.provider.name,
        upstreamFormat: result.req.provider.format,
      }
    }
    if (result.kind === "stream") {
      return {
        model: result.state.model,
        resolvedModel: result.state.resolvedModel,
        inputTokens: result.state.inputTokens,
        outputTokens: result.state.outputTokens,
        upstream: result.state.upstream,
        upstreamFormat: result.state.upstreamFormat,
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

/** Type guard for OpenAI non-streaming response */
function isOpenAINonStreaming(
  response: ChatCompletionResponse | AsyncGenerator<ServerSentEvent>,
): response is ChatCompletionResponse {
  return typeof response === "object" && "object" in response && response.object === "chat.completion"
}

