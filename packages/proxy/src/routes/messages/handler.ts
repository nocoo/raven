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
import { extractErrorDetails, forwardError } from "./../../lib/error"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
} from "./../../protocols/anthropic/types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../../protocols/translate/non-stream-translation"
import { consumeStreamToResponse } from "../../protocols/translate/consume-stream"
export { consumeStreamToResponse } from "../../protocols/translate/consume-stream"
import { preprocessPayload, translateModelName } from "./../../protocols/anthropic/preprocess"
import { supportsNativeMessages } from "../../strategies/support/model-capabilities"
import { handleCopilotNativeServerTools } from "./native-handler"
import { withServerToolInterception } from "../../strategies/support/server-tools"
import { streamAnthropicResponse } from "../../strategies/support/anthropic-stream-writer"
export { streamAnthropicResponse } from "../../strategies/support/anthropic-stream-writer"

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

    // H.8: Server-tools sub-branch stays in the legacy handler until Phase I.
    // The default (no server-tools) path routes through composition.dispatch.
    const webSearchEnabled = state.stWebSearchEnabled && state.stWebSearchApiKey !== null
    if (serverToolContext.hasServerSideTools && webSearchEnabled) {
      return handleCopilotNativeServerTools(
        c,
        requestId,
        cleanedPayload,
        startTime,
        copilotModel,
        filteredBeta,
        serverToolContext,
        { accountName, sessionId, clientName, clientVersion },
      )
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

  // G.9: server-tools sub-branch remains inline because it runs its own
  // request loop via `withServerToolInterception`. Default (no server-tools)
  // path below routes through Runner via copilotTranslatedShim.
  if (serverToolContext.hasServerSideTools && webSearchEnabled) {
    try {
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

      const serverToolResponse = await withServerToolInterception(
        anthropicPayload,
        serverToolContext,
        sendTranslatedRequest,
        requestId,
      )

      const latencyMs = Math.round(performance.now() - startTime)

      logEmitter.emitLog({
        ts: Date.now(), level: "info", type: "request_end", requestId,
        msg: `200 ${model} ${latencyMs}ms (translated+server-tools)`,
        data: {
          path: "/v1/messages", format: "anthropic", model,
          resolvedModel: serverToolResponse.model,
          translatedModel: openAIPayload.model,
          inputTokens: serverToolResponse.usage?.input_tokens ?? 0,
          outputTokens: serverToolResponse.usage?.output_tokens ?? 0,
          latencyMs,
          ttftMs: null, processingMs: null,
          stream: false, status: "success", statusCode: 200,
          upstreamStatus: 200, routingPath: "translated",
          serverToolsUsed: true,
          accountName, sessionId, clientName, clientVersion,
        },
      })

      // Client requested streaming — emit as SSE events
      if (stream) {
        return streamAnthropicResponse(c, serverToolResponse)
      }
      return c.json(serverToolResponse)
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime)
      const { errorDetail, upstreamStatus, statusCode } = extractErrorDetails(error)

      logEmitter.emitLog({
        ts: Date.now(), level: "error", type: "request_end", requestId,
        msg: `${statusCode} ${model} ${latencyMs}ms`,
        data: {
          path: "/v1/messages", format: "anthropic", model, stream,
          latencyMs, status: "error", statusCode,
          upstreamStatus, error: errorDetail, accountName,
          sessionId, clientName, clientVersion,
        },
      })
      throw error
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

// ===========================================================================
// G.9 + G.11: Strategy shims — REMOVED (H.16/H.14):
//   copilot-translated → strategies/copilot-translated.ts
//   custom-anthropic   → strategies/custom-anthropic.ts
// All branches now flow through composition.dispatch.
// ===========================================================================


