import type { Context } from "hono"

import { checkRateLimit } from "./../../lib/rate-limit"
import { state } from "./../../lib/state"
import { resolveProviderForModels } from "./../../lib/upstream-router"
import { pickStrategy } from "./../../core/router"
import { respondRouterReject } from "./../../core/router-reject"
import type { RequestContext as RunnerCtx } from "./../../core/context"
import { logEmitter } from "./../../util/log-emitter"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"
import { buildUpstreamClient } from "../../composition/upstream-registry"
import { dispatch as compositionDispatch } from "../../composition"
import type { CopilotNativeUpReq } from "../../strategies/copilot-native"
import type { CustomOpenAIUpReq } from "../../strategies/custom-openai"
import type { CustomAnthropicUpReq } from "../../strategies/custom-anthropic"
import type { CopilotTranslatedUpReq } from "../../strategies/copilot-translated"
import type { ServerSentEvent } from "./../../util/sse"
import { forwardError, HTTPError } from "./../../lib/error"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
} from "./../../protocols/anthropic/types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../../protocols/translate/non-stream-translation"
import { consumeStreamToResponse } from "../../protocols/translate/consume-stream"
import { preprocessPayload, translateModelName } from "./../../protocols/anthropic/preprocess"
import { supportsNativeMessages } from "../../strategies/support/model-capabilities"
import { decorate as decorateServerTools } from "../../strategies/support/server-tools"
import type { NativeMessagesOptions } from "../../upstream/copilot-native"
import {
  parseReasoningEffortError,
  pickSupportedEffort,
  adjustEffortInPayload,
  logEffortFallback,
} from "../../strategies/support/effort-fallback"

export async function handleCompletion(c: Context) {
  const startTime = performance.now()
  const requestId = generateRequestId()

  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const model = anthropicPayload.model
  const stream = !!anthropicPayload.stream
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const anthropicBeta = c.req.header("anthropic-beta") ?? null
  const userId = anthropicPayload.metadata?.user_id ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(userId, userAgent, accountName, null)

  // --- request_start ---
  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/messages ${model}`,
    data: {
      path: "/v1/messages", format: "anthropic", model, stream,
      messageCount: anthropicPayload.messages?.length ?? 0,
      toolCount: anthropicPayload.tools?.length ?? 0,
      accountName, sessionId, clientName, clientVersion,
    },
  })

  // Debug: log tool definitions
  if (state.optToolCallDebug && anthropicPayload.tools) {
    logEmitter.emitLog({
      ts: Date.now(), level: "debug", type: "request_start", requestId,
      msg: `tool definitions: ${anthropicPayload.tools.length}`,
      data: {
        toolDefinitions: anthropicPayload.tools.map((t: { name: string; type?: string }) => ({ name: t.name, type: t.type ?? "none" })),
        toolDefinitionCount: anthropicPayload.tools.length,
      },
    })
  }

  // §2.2(7) normalisation: a provider pattern authored in canonical
  // Copilot form (e.g. `claude-opus-4.6`) must match incoming raw
  // dated inputs (e.g. `claude-opus-4-6-20250820`). The router
  // (core/router.ts::pickStrategy) feeds both raw + normalised
  // candidates into a two-pass matcher; we mirror the candidate list
  // here so we can fetch the resolved provider object for handler
  // dispatch (the router only returns providerId). Composition root
  // (§3.8, Phase H) will move provider resolution into the strategy
  // factory.
  const normalisedModel = translateModelName(model, anthropicBeta)
  const candidates = normalisedModel !== model ? [model, normalisedModel] : [model]

  const decision = pickStrategy({
    protocol: "anthropic",
    model,
    anthropicBeta,
    providers: state.providers,
    modelsCatalogIds: state.models?.data?.map((m) => m.id) ?? [],
  })

  // Defensive guard: pickStrategy currently never rejects for the
  // anthropic protocol, but if a future reject branch is added (per
  // §3.2) we must surface it via the central mapper instead of
  // silently falling through to the translated path below.
  if (decision.kind === "reject") {
    return respondRouterReject(c, decision, {
      requestId, startTime,
      path: "/v1/messages", format: "anthropic",
      model, stream,
      accountName, sessionId, clientName, clientVersion,
    })
  }

  if (decision.name === "custom-anthropic" || decision.name === "custom-openai") {
    const resolved = resolveProviderForModels(candidates)
    if (!resolved) throw new Error(`router/handler drift: no provider for ${model}`)
    const { provider } = resolved

    if (decision.name === "custom-anthropic") {
      const runnerCtx: RunnerCtx = {
        requestId, startTime, format: "anthropic", path: "/v1/messages",
        stream,
        accountName, userAgent, anthropicBeta,
        sessionId, clientName, clientVersion,
      }
      const anthReq: CustomAnthropicUpReq = { provider, payload: anthropicPayload }
      try {
        return await compositionDispatch(c, runnerCtx, anthReq, "anthropic", {
          model,
          stream,
          anthropicBeta,
          providers: state.providers,
          models: state.models?.data ?? [],
          buildDeps: { toolCallDebug: state.optToolCallDebug },
        })
      } catch (error) {
        return forwardError(c, error)
      }
    }

    // custom-openai: translate Anthropic → OpenAI, then forward
    const targetFormat = provider.supports_reasoning ? "openai-reasoning" : "openai"

    if (!provider.supports_reasoning && anthropicPayload.thinking?.type === "enabled") {
      logEmitter.emitLog({
        ts: Date.now(),
        level: "debug",
        type: "system",
        requestId,
        msg: `thinking parameter dropped: provider "${provider.name}" does not declare supports_reasoning (budget=${anthropicPayload.thinking.budget_tokens})`,
        data: {
          provider: provider.name,
          budgetTokens: anthropicPayload.thinking.budget_tokens,
          hint: "Add supports_reasoning: true to provider config if upstream supports reasoning_effort",
        },
      })
    }

    const openAIPayload = translateToOpenAI(anthropicPayload, {
      targetFormat,
      anthropicBeta,
      sanitizeOrphanedToolResults: state.optSanitizeOrphanedToolResults,
      reorderToolResults: state.optReorderToolResults,
    })
    const runnerCtx: RunnerCtx = {
      requestId, startTime, format: "anthropic", path: "/v1/messages",
      stream,
      accountName, userAgent, anthropicBeta,
      sessionId, clientName, clientVersion,
    }
    const customReq: CustomOpenAIUpReq = {
      provider, payload: openAIPayload, originalModel: model,
    }
    try {
      return await compositionDispatch(c, runnerCtx, customReq, "anthropic", {
        model,
        stream,
        anthropicBeta,
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

  // --- Preprocessing: normalize model name, filter beta, detect server tools ---
  const preprocessed = preprocessPayload(anthropicPayload, anthropicBeta)
  const { payload: cleanedPayload, copilotModel, anthropicBeta: filteredBeta, serverToolContext } = preprocessed

  // --- Native Messages Routing ---
  // Router (pickStrategy) checks catalog membership + `claude-*` prefix.
  // Runtime gate (supportsNativeMessages) additionally verifies the
  // model declares /v1/messages in `supported_endpoints` — see
  // core/router.ts comment on `nativeSupported`. Both must agree to
  // dispatch native; otherwise fall through to the translated path.
  if (
    decision.name === "copilot-native" &&
    supportsNativeMessages(copilotModel)
  ) {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "debug",
      type: "request_start",
      requestId,
      msg: `routing to native /v1/messages: ${copilotModel}`,
      data: {
        rawModel: model,
        copilotModel,
        routingPath: "native",
        serverToolContext,
      },
    })

    // I.3/J.1: Server-tools sub-branch folded inline via `decorate()`.
    // The default (no server-tools) path routes through composition.dispatch.
    const webSearchEnabled = state.stWebSearchEnabled && state.stWebSearchApiKey !== null
    if (serverToolContext.hasServerSideTools && webSearchEnabled) {
      if (state.optToolCallDebug) {
        logEmitter.emitLog({
          ts: Date.now(), level: "debug", type: "request_start", requestId,
          msg: `native path: server-tool check: hasServerSideTools=true, webSearchEnabled=true`,
          data: {
            hasServerSideTools: serverToolContext.hasServerSideTools,
            webSearchEnabled: true,
            serverSideToolNames: serverToolContext.serverSideToolNames,
            allServerSide: serverToolContext.allServerSide,
          },
        })
      }
      const nativeOptions: NativeMessagesOptions = { copilotModel, anthropicBeta: filteredBeta }
      try {
        return await decorateServerTools({
          c, requestId, startTime, stream, model,
          payload: cleanedPayload,
          serverToolContext,
          sendRequest: createNativeSendNonStreaming(nativeOptions, requestId),
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

    // No server-tools: route through Runner via copilot-native strategy.
    const runnerCtx: RunnerCtx = {
      requestId, startTime, format: "anthropic", path: "/v1/messages",
      stream,
      accountName, userAgent, anthropicBeta,
      sessionId, clientName, clientVersion,
    }
    const nativeReq: CopilotNativeUpReq = {
      payload: cleanedPayload,
      options: { copilotModel, anthropicBeta: filteredBeta },
      originalModel: model,
    }
    try {
      return await compositionDispatch(c, runnerCtx, nativeReq, "anthropic", {
        model,
        stream,
        anthropicBeta,
        providers: state.providers,
        models: state.models?.data ?? [],
        buildDeps: { toolCallDebug: state.optToolCallDebug },
      })
    } catch (error) {
      return forwardError(c, error)
    }
  }

  // --- Translated Path (non-Claude models via Copilot) ---
  // Reuse serverToolContext from preprocessed result (already computed above)
  const openAIPayload = translateToOpenAI(anthropicPayload, {
    targetFormat: "copilot",
    anthropicBeta,
    sanitizeOrphanedToolResults: state.optSanitizeOrphanedToolResults,
    reorderToolResults: state.optReorderToolResults,
  })

  // Debug log if thinking was requested but dropped (Copilot doesn't support it)
  if (anthropicPayload.thinking?.type === "enabled") {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "debug",
      type: "system",
      requestId,
      msg: `thinking parameter dropped: Copilot does not support extended thinking (budget=${anthropicPayload.thinking.budget_tokens})`,
      data: {
        budgetTokens: anthropicPayload.thinking.budget_tokens,
        hint: "Configure an Anthropic provider to use thinking",
      },
    })
  }

  // Check if we need to handle server-side tools (web_search)
  const webSearchEnabled = state.stWebSearchEnabled && state.stWebSearchApiKey !== null

  // Debug: log server-tool detection result
  if (state.optToolCallDebug && serverToolContext.hasServerSideTools) {
    logEmitter.emitLog({
      ts: Date.now(), level: "debug", type: "request_start", requestId,
      msg: `translated path: server-tool check: hasServerSideTools=${serverToolContext.hasServerSideTools}, webSearchEnabled=${webSearchEnabled}`,
      data: {
        hasServerSideTools: serverToolContext.hasServerSideTools,
        webSearchEnabled,
        serverSideToolNames: serverToolContext.serverSideToolNames,
        allServerSide: serverToolContext.allServerSide,
      },
    })
  }

  // I.2: server-tools sub-branch now runs through `decorate()` which wraps
  // `withServerToolInterception` + the request_end log + SSE replay. The
  // default (no server-tools) path below routes through composition.dispatch
  // (copilot-translated strategy).
  if (serverToolContext.hasServerSideTools && webSearchEnabled) {
    // Create sendRequest wrapper: Anthropic → OpenAI → send → OpenAI response → Anthropic
    const sendTranslatedRequest = async (p: AnthropicMessagesPayload): Promise<AnthropicResponse> => {
      const translated = translateToOpenAI(p, {
        targetFormat: "copilot",
        anthropicBeta,
        sanitizeOrphanedToolResults: state.optSanitizeOrphanedToolResults,
        reorderToolResults: state.optReorderToolResults,
      })
      const streamResponse = await buildUpstreamClient("copilot-openai").send({ ...translated, stream: true })
      const response = await consumeStreamToResponse(streamResponse as AsyncGenerator<ServerSentEvent>)
      return translateToAnthropic(response, model)
    }

    try {
      return await decorateServerTools({
        c, requestId, startTime, stream, model,
        payload: anthropicPayload,
        serverToolContext,
        sendRequest: sendTranslatedRequest,
        log: {
          path: "/v1/messages", format: "anthropic",
          accountName, sessionId, clientName, clientVersion,
          extras: {
            translatedModel: openAIPayload.model,
            routingPath: "translated",
          },
        },
      })
    } catch (error) {
      return forwardError(c, error)
    }
  }

  // No server-side tools: route through composition.dispatch via copilot-translated.
  const runnerCtx: RunnerCtx = {
    requestId, startTime, format: "anthropic", path: "/v1/messages",
    stream,
    accountName, userAgent, anthropicBeta,
    sessionId, clientName, clientVersion,
  }
  const translatedReq: CopilotTranslatedUpReq = { openAIPayload, originalModel: model }
  try {
    return await compositionDispatch(c, runnerCtx, translatedReq, "anthropic", {
      model,
      stream,
      anthropicBeta,
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

// ---------------------------------------------------------------------------
// Native-path server-tool helpers (J.1: folded in from routes/messages/native-handler.ts)
// ---------------------------------------------------------------------------

async function nativeSendWithEffortFallback(
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

function createNativeSendNonStreaming(
  nativeOptions: NativeMessagesOptions,
  requestId: string,
): (p: AnthropicMessagesPayload) => Promise<AnthropicResponse> {
  return async (p: AnthropicMessagesPayload): Promise<AnthropicResponse> => {
    const nonStreamPayload: AnthropicMessagesPayload = { ...p, stream: false }
    const result = await nativeSendWithEffortFallback(nonStreamPayload, nativeOptions, requestId)
    return result as AnthropicResponse
  }
}
