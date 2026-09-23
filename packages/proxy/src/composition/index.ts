import type { Context } from "hono"
import type { RequestContext } from "../core/context"
import { pickStrategy, type ClientProtocol, type StrategyDecision } from "../core/router"
import { RoutingError, type UpstreamRecord } from "../core/routing-types"
import { logRequestError } from "../core/request-log"
import { routingLog } from "../core/routing-log"
import { execute } from "../core/runner"
import { checkRateLimit } from "../lib/rate-limit"
import { state } from "../lib/state"
import { preprocessPayload } from "../protocols/anthropic/preprocess"
import type { AnthropicMessagesPayload, AnthropicResponse } from "../protocols/anthropic/types"
import { translateToOpenAI } from "../protocols/translate/non-stream-translation"
import { consumeStreamToResponse } from "../protocols/translate/consume-stream"
import { decorate } from "../strategies/support/server-tools"
import type { ChatCompletionsPayload } from "../upstream/copilot-openai"
import type { ResponsesPayload } from "../upstream/copilot-responses"
import { buildStrategy, type BuildStrategyDeps } from "./strategy-registry"
import { accountedFetch, resolveRouting } from "./routing"
import { logEmitter } from "../util/log-emitter"

export type GenerationPayload = AnthropicMessagesPayload | ChatCompletionsPayload | ResponsesPayload
export type { ClientProtocol } from "../core/router"
export type { StrategyName } from "../core/strategy"

type Decision = Extract<StrategyDecision, { kind: "ok" }>

function preparePayload(
  payload: GenerationPayload,
  protocol: ClientProtocol,
  decision: Decision,
  provider: UpstreamRecord,
  deps: BuildStrategyDeps,
): unknown {
  const resolved = { ...payload, model: decision.model }
  if (protocol === "anthropic") {
    const messages = resolved as AnthropicMessagesPayload
    if (decision.name === "copilot-native") {
      const cleaned = preprocessPayload(messages, deps.anthropicBeta ?? null, provider.models.map((m) => m.id))
      return { payload: cleaned.payload, options: { copilotModel: decision.model, anthropicBeta: cleaned.anthropicBeta }, originalModel: decision.model }
    }
    if (decision.name === "copilot-translated" || decision.name === "custom-openai") {
      const translated = translateToOpenAI(messages, {
        targetFormat: provider.kind === "copilot" ? "copilot" : provider.supports_reasoning ? "openai-reasoning" : "openai",
        anthropicBeta: deps.anthropicBeta ?? null,
        sanitizeOrphanedToolResults: deps.sanitizeOrphanedToolResults ?? false,
        reorderToolResults: deps.reorderToolResults ?? false,
      })
      translated.model = decision.model
      return decision.name === "copilot-translated"
        ? { openAIPayload: translated, originalModel: decision.model }
        : { provider, payload: translated, originalModel: decision.model }
    }
  }
  if (decision.name === "custom-anthropic" || decision.name === "custom-openai") return { provider, payload: resolved }
  return resolved
}

export async function dispatch(
  c: Context,
  ctx: RequestContext,
  payload: GenerationPayload,
  protocol: ClientProtocol,
): Promise<Response> {
  let executionOwnsLog = false
  try {
    const selection = resolveRouting(c, ctx, payload.model)
    const decision = pickStrategy({
      protocol, model: selection.resolved_model, requestedModel: selection.requested_model,
      provider: selection.upstream, allowConversion: selection.allow_conversion, anthropicBeta: ctx.anthropicBeta,
    })
    if (decision.kind === "reject") throw new RoutingError(decision.message, decision.errorType, decision.status as 400 | 503)
    selection.resolved_model = decision.model
    ctx.upstreamProtocol = decision.upstreamProtocol
    const deps: BuildStrategyDeps = {
      provider: selection.upstream,
      toolCallDebug: state.optToolCallDebug,
      includeUsage: protocol === "openai" && ((payload as ChatCompletionsPayload).stream_options?.include_usage ?? selection.upstream.quota !== null),
      anthropicBeta: ctx.anthropicBeta,
      sanitizeOrphanedToolResults: state.optSanitizeOrphanedToolResults,
      reorderToolResults: state.optReorderToolResults,
      transport: { fetch: accountedFetch(c, ctx, decision.upstreamProtocol) },
    }
    const strategy = buildStrategy(decision, deps)
    const resolvedPayload = { ...payload, model: decision.model }
    const serverTools = protocol === "anthropic" && selection.upstream.kind === "copilot"
      ? preprocessPayload(resolvedPayload as AnthropicMessagesPayload, ctx.anthropicBeta, selection.upstream.models.map((m) => m.id))
      : null
    if (protocol === "anthropic") {
      const messages = payload as AnthropicMessagesPayload
      if (state.optToolCallDebug && messages.tools) logEmitter.emitLog({
        ts: Date.now(), level: "debug", type: "request_start", requestId: ctx.requestId,
        msg: `tool definitions: ${messages.tools.length}`,
        data: { toolDefinitions: messages.tools.map((tool) => ({ name: tool.name, type: tool.type ?? "none" })), toolDefinitionCount: messages.tools.length },
      })
      if (decision.upstreamProtocol === "openai" && messages.thinking?.type === "enabled" && (selection.upstream.kind === "copilot" || !selection.upstream.supports_reasoning)) logEmitter.emitLog({
        ts: Date.now(), level: "debug", type: "system", requestId: ctx.requestId,
        msg: selection.upstream.kind === "copilot" ? "thinking parameter dropped: Copilot does not support extended thinking" : `thinking parameter dropped: provider "${selection.upstream.name}" does not declare supports_reasoning`,
        data: { provider: selection.upstream.name, budgetTokens: messages.thinking.budget_tokens, hint: "Configure an Anthropic provider or enable supports_reasoning on a compatible upstream" },
      })
      if (state.optToolCallDebug && serverTools?.serverToolContext.hasServerSideTools) logEmitter.emitLog({
        ts: Date.now(), level: "debug", type: "request_start", requestId: ctx.requestId,
        msg: "server-tool check",
        data: { ...serverTools.serverToolContext, webSearchEnabled: state.stWebSearchEnabled && state.stWebSearchApiKey !== null },
      })
    }
    const intercept = serverTools?.serverToolContext.hasServerSideTools
      && state.stWebSearchEnabled && state.stWebSearchApiKey !== null
    if (protocol === "openai" && state.optToolCallDebug && (payload as ChatCompletionsPayload).tools) {
      const tools = (payload as ChatCompletionsPayload).tools!
      logEmitter.emitLog({
        ts: Date.now(), level: "debug", type: "request_start", requestId: ctx.requestId,
        msg: `tool definitions: ${tools.length}`,
        data: { toolDefinitions: tools.map((tool) => tool.function.name), toolDefinitionCount: tools.length },
      })
    }
    await checkRateLimit(state)

    if (intercept && serverTools) {
      executionOwnsLog = true
      return await decorate({
        c, requestId: ctx.requestId, startTime: ctx.startTime, stream: ctx.stream, model: decision.model,
        payload: serverTools.payload, serverToolContext: serverTools.serverToolContext,
        sendRequest: async (messages, signal) => {
          const roundCtx = { ...ctx, ...(signal ? { signal } : {}) }
          const roundPayload = { ...messages, model: decision.model, stream: decision.name === "copilot-translated" }
          const up = strategy.prepare(preparePayload(roundPayload, protocol, decision, selection.upstream, deps), roundCtx)
          const result = await strategy.dispatch(up, roundCtx)
          const body = result.kind === "json" ? result.body : await consumeStreamToResponse((async function* () { yield* result.chunks })())
          return strategy.adaptJson(body, up, roundCtx) as AnthropicResponse
        },
        log: {
          path: ctx.path, format: ctx.format, accountName: ctx.accountName, apiKeyId: ctx.keyId,
          sessionId: ctx.sessionId, clientName: ctx.clientName, clientVersion: ctx.clientVersion,
          get extras() { return { strategy: decision.name, routingPath: decision.upstreamProtocol === "anthropic" ? "native" : "translated", upstreamFormat: decision.upstreamProtocol, ...routingLog(ctx) } },
        },
      })
    }

    let prepared = resolvedPayload
    if (protocol === "openai" && selection.upstream.kind === "copilot") {
      const chat = resolvedPayload as ChatCompletionsPayload
      const { max_tokens, ...rest } = chat
      const capabilities = selection.upstream.models.find((m) => m.id === decision.model)?.capabilities as { limits?: { max_output_tokens?: number } } | undefined
      const limit = chat.max_completion_tokens ?? max_tokens ?? capabilities?.limits?.max_output_tokens
      prepared = { ...rest, ...(limit === undefined ? {} : { max_completion_tokens: limit }) }
    }
    const input = preparePayload(prepared, protocol, decision, selection.upstream, deps)
    executionOwnsLog = true
    return await execute(c, ctx, strategy, input)
  } catch (error) {
    if (!executionOwnsLog) logRequestError(ctx, error, { model: payload.model })
    throw error
  }
}
