import type { Context } from "hono"

import { checkRateLimit } from "./../../lib/rate-limit"
import { state } from "./../../lib/state"
import { resolveProvider } from "./../../lib/upstream-router"
import { pickStrategy } from "./../../core/router"
import { respondRouterReject } from "./../../core/router-reject"
import type { RequestContext as RunnerCtx } from "./../../core/context"
import type { CustomOpenAIUpReq } from "./../../strategies/custom-openai"
import { isNullish } from "./../../lib/utils"
import { logEmitter } from "./../../util/log-emitter"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"
import { dispatch as compositionDispatch } from "./../../composition"
import type { ChatCompletionsPayload } from "./../../upstream/copilot-openai"
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
    const customReq: CustomOpenAIUpReq = { provider: resolved.provider, payload }
    try {
      return await compositionDispatch(c, runnerCtx, customReq, "openai", {
        model,
        stream,
        anthropicBeta: null,
        providers: state.providers,
        models: state.models?.data ?? [],
        buildDeps: {
          toolCallDebug: state.optToolCallDebug,
          filterWhitespaceChunks: state.optFilterWhitespaceChunks,
        },
      })
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

  // decision.name === "copilot-openai-direct"
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
