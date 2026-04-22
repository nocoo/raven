import type { Context } from "hono"

import { type SSEMessage } from "hono/streaming"

import { checkRateLimit } from "./../../lib/rate-limit"
import { state } from "./../../lib/state"
import { resolveProviderForModels } from "./../../lib/upstream-router"
import { pickStrategy } from "./../../core/router"
import { respondRouterReject } from "./../../core/router-reject"
import { execute as runnerExecute } from "./../../core/runner"
import type { RequestContext as RunnerCtx } from "./../../core/context"
import type { Strategy } from "./../../core/strategy"
import type { CompiledProvider } from "./../../db/providers"
import { logEmitter } from "./../../util/log-emitter"
import { emitUpstreamRawSse } from "./../../util/emit-upstream-raw"
import { generateRequestId } from "./../../util/id"
import { deriveClientIdentity } from "./../../util/client-identity"
import { buildUpstreamClient } from "../../composition/upstream-registry"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../upstream/copilot-openai"
import type { ServerSentEvent } from "./../../util/sse"
import { extractErrorDetails, forwardError } from "./../../lib/error"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamState,
} from "./../../protocols/anthropic/types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../../protocols/translate/non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "../../protocols/translate/stream-translation"
import { consumeStreamToResponse } from "../../protocols/translate/consume-stream"
export { consumeStreamToResponse } from "../../protocols/translate/consume-stream"
import { preprocessPayload, translateModelName } from "./../../protocols/anthropic/preprocess"
import { supportsNativeMessages } from "../../strategies/support/model-capabilities"
import { handleCopilotNative } from "./native-handler"
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
        accountName, userAgent, anthropicBeta,
        sessionId, clientName, clientVersion,
      }
      try {
        return await runnerExecute(c, runnerCtx, customAnthropicShim, {
          provider, payload: anthropicPayload,
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
      accountName, userAgent, anthropicBeta,
      sessionId, clientName, clientVersion,
    }
    try {
      return await runnerExecute(c, runnerCtx, customOpenAIShim, {
        provider, openAIPayload, originalModel: model,
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

    return handleCopilotNative(
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

  // No server-side tools: route through Runner via copilotTranslatedShim.
  const runnerCtx: RunnerCtx = {
    requestId, startTime, format: "anthropic", path: "/v1/messages",
    accountName, userAgent, anthropicBeta,
    sessionId, clientName, clientVersion,
  }
  return await runnerExecute(c, runnerCtx, copilotTranslatedShim, {
    openAIPayload, originalModel: model,
  })
}

const isNonStreaming = (
  response: ChatCompletionResponse | AsyncGenerator<ServerSentEvent>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")



/** Type guard for Anthropic non-streaming response */
function isAnthropicNonStreaming(
  response: AnthropicResponse | AsyncGenerator<ServerSentEvent>,
): response is AnthropicResponse {
  return typeof response === "object" && "type" in response && response.type === "message"
}

// ===========================================================================
// G.9: Strategy shim — copilot-translated (Anthropic client ↔ Copilot OpenAI
// upstream). Local to this file. The real `strategies/copilot-translated.ts`
// lands in Phase H once all messages branches are on Runner.
// ===========================================================================

interface CopilotTranslatedUpReq {
  /** Already-translated OpenAI payload sent to Copilot */
  openAIPayload: ChatCompletionsPayload
  /** Original Anthropic-side model name (used in translateToAnthropic + logs) */
  originalModel: string
}

interface CopilotTranslatedStreamState extends AnthropicStreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  lastToolCallCount: number
  originalModel: string
}

const copilotTranslatedShim: Strategy<
  CopilotTranslatedUpReq,
  CopilotTranslatedUpReq,
  ChatCompletionResponse,
  unknown,
  ServerSentEvent,
  SSEMessage,
  CopilotTranslatedStreamState
> = {
  name: "copilot-translated",

  prepare: (req) => req,

  dispatch: async (up) => {
    const response = await buildUpstreamClient("copilot-openai").send(up.openAIPayload)
    if (isNonStreaming(response)) {
      return { kind: "json", body: response }
    }
    return { kind: "stream", chunks: response }
  },

  adaptJson: (resp, req) => translateToAnthropic(resp, req.originalModel),

  initStreamState: (req) => ({
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    resolvedModel: req.originalModel,
    inputTokens: 0,
    outputTokens: 0,
    lastToolCallCount: 0,
    originalModel: req.originalModel,
  }),

  adaptChunk: (rawEvent, st, ctx) => {
    emitUpstreamRawSse(ctx.requestId, { event: rawEvent.event, data: rawEvent.data })
    if (rawEvent.data === "[DONE]") return []
    if (!rawEvent.data) return []

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

    if (chunk.model) st.resolvedModel = chunk.model
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
      st.inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached
      st.outputTokens = chunk.usage.completion_tokens ?? 0
    }

    const events = translateChunkToAnthropicEvents(chunk, st, st.originalModel, {
      filterWhitespaceChunks: state.optFilterWhitespaceChunks,
    })

    if (state.optToolCallDebug) {
      const currentToolCallCount = Object.keys(st.toolCalls).length
      if (currentToolCallCount > st.lastToolCallCount) {
        const newToolCall = Object.values(st.toolCalls).reduce((newest, tc) =>
          tc.anthropicBlockIndex > newest.anthropicBlockIndex ? tc : newest,
          { id: "", name: "", anthropicBlockIndex: -1 },
        )
        if (newToolCall.id) {
          logEmitter.emitLog({
            ts: Date.now(), level: "debug", type: "sse_chunk", requestId: ctx.requestId,
            msg: `tool_use started: ${newToolCall.name}`,
            data: {
              eventType: "tool_use_start",
              toolName: newToolCall.name,
              toolId: newToolCall.id,
              blockIndex: newToolCall.anthropicBlockIndex,
            },
          })
        }
      }
      st.lastToolCallCount = currentToolCallCount
    }

    return events.map((event) => ({
      event: event.type,
      data: JSON.stringify(event),
    }))
  },

  adaptStreamError: () => {
    const errorEvent = translateErrorToAnthropicErrorEvent()
    return [{
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    }]
  },

  describeEndLog: (result) => {
    if (result.kind === "json") {
      const cached = result.resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (result.resp.usage?.prompt_tokens ?? 0) - cached
      const outputTokens = result.resp.usage?.completion_tokens ?? 0
      return {
        model: result.req.originalModel,
        resolvedModel: result.resp.model,
        translatedModel: result.req.openAIPayload.model,
        inputTokens, outputTokens,
      }
    }
    if (result.kind === "stream") {
      const debugExtras = state.optToolCallDebug
        ? {
          stopReason: "tool_use",
          toolCallCount: Object.keys(result.state.toolCalls).length,
          toolCallNames: Object.values(result.state.toolCalls).map((tc) => tc.name),
        }
        : {}
      return {
        model: result.req.originalModel,
        resolvedModel: result.state.resolvedModel,
        translatedModel: result.req.openAIPayload.model,
        inputTokens: result.state.inputTokens,
        outputTokens: result.state.outputTokens,
        ...debugExtras,
      }
    }
    if (result.kind === "error") {
      return {
        model: result.req.originalModel,
        translatedModel: result.req.openAIPayload.model,
      }
    }
    return {}
  },
}

// ===========================================================================
// G.10: Strategy shim — custom-openai (Anthropic client ↔ user-configured
// OpenAI-format upstream). Translates Anthropic ↔ OpenAI in the route layer
// (already done before runnerExecute) and runs translation on the response /
// stream chunks. Local to this file; promoted in Phase H.
// ===========================================================================

interface CustomOpenAIUpReq {
  provider: CompiledProvider
  openAIPayload: ChatCompletionsPayload
  originalModel: string
}

interface CustomOpenAIStreamState extends AnthropicStreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  lastToolCallCount: number
  originalModel: string
}

const customOpenAIShim: Strategy<
  CustomOpenAIUpReq,
  CustomOpenAIUpReq,
  ChatCompletionResponse,
  unknown,
  ServerSentEvent,
  SSEMessage,
  CustomOpenAIStreamState
> = {
  name: "custom-openai",

  prepare: (req) => req,

  dispatch: async (up) => {
    const response = await buildUpstreamClient("custom-openai").send({
      provider: up.provider, payload: up.openAIPayload,
    })
    if (isNonStreaming(response)) {
      return { kind: "json", body: response }
    }
    return { kind: "stream", chunks: response }
  },

  adaptJson: (resp, req) => translateToAnthropic(resp, req.originalModel),

  initStreamState: (req) => ({
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    resolvedModel: req.openAIPayload.model,
    inputTokens: 0,
    outputTokens: 0,
    lastToolCallCount: 0,
    originalModel: req.originalModel,
  }),

  adaptChunk: (rawEvent, st, ctx) => {
    emitUpstreamRawSse(ctx.requestId, { event: rawEvent.event, data: rawEvent.data })
    if (rawEvent.data === "[DONE]") return []
    if (!rawEvent.data) return []

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

    if (chunk.model) st.resolvedModel = chunk.model
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
      st.inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached
      st.outputTokens = chunk.usage.completion_tokens ?? 0
    }

    const events = translateChunkToAnthropicEvents(chunk, st, st.originalModel, {
      filterWhitespaceChunks: state.optFilterWhitespaceChunks,
    })

    if (state.optToolCallDebug) {
      const currentToolCallCount = Object.keys(st.toolCalls).length
      if (currentToolCallCount > st.lastToolCallCount) {
        const newToolCall = Object.values(st.toolCalls).reduce((newest, tc) =>
          tc.anthropicBlockIndex > newest.anthropicBlockIndex ? tc : newest,
          { id: "", name: "", anthropicBlockIndex: -1 },
        )
        if (newToolCall.id) {
          logEmitter.emitLog({
            ts: Date.now(), level: "debug", type: "sse_chunk", requestId: ctx.requestId,
            msg: `tool_use started: ${newToolCall.name}`,
            data: {
              eventType: "tool_use_start",
              toolName: newToolCall.name,
              toolId: newToolCall.id,
              blockIndex: newToolCall.anthropicBlockIndex,
            },
          })
        }
      }
      st.lastToolCallCount = currentToolCallCount
    }

    return events.map((event) => ({
      event: event.type,
      data: JSON.stringify(event),
    }))
  },

  adaptStreamError: () => {
    const errorEvent = translateErrorToAnthropicErrorEvent()
    return [{
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    }]
  },

  describeEndLog: (result) => {
    if (result.kind === "json") {
      const cached = result.resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const inputTokens = (result.resp.usage?.prompt_tokens ?? 0) - cached
      const outputTokens = result.resp.usage?.completion_tokens ?? 0
      return {
        model: result.req.originalModel,
        resolvedModel: result.resp.model,
        translatedModel: result.req.openAIPayload.model,
        inputTokens, outputTokens,
        upstream: result.req.provider.name,
        upstreamFormat: result.req.provider.format,
      }
    }
    if (result.kind === "stream") {
      const debugExtras = state.optToolCallDebug
        ? {
          stopReason: "tool_use",
          toolCallCount: Object.keys(result.state.toolCalls).length,
          toolCallNames: Object.values(result.state.toolCalls).map((tc) => tc.name),
        }
        : {}
      return {
        model: result.req.originalModel,
        resolvedModel: result.state.resolvedModel,
        translatedModel: result.req.openAIPayload.model,
        inputTokens: result.state.inputTokens,
        outputTokens: result.state.outputTokens,
        upstream: result.req.provider.name,
        upstreamFormat: result.req.provider.format,
        ...debugExtras,
      }
    }
    if (result.kind === "error") {
      return {
        model: result.req.originalModel,
        upstream: result.req.provider.name,
        upstreamFormat: result.req.provider.format,
      }
    }
    return {}
  },
}

// ===========================================================================
// G.11: Strategy shim — custom-anthropic (Anthropic client ↔ Anthropic-format
// provider, passthrough). No translation; just forward bytes and pull token
// usage out of `message_delta`. Local to this file; promoted in Phase H.
// ===========================================================================

interface CustomAnthropicUpReq {
  provider: CompiledProvider
  payload: AnthropicMessagesPayload
}

interface CustomAnthropicStreamState {
  inputTokens: number
  outputTokens: number
}

const customAnthropicShim: Strategy<
  CustomAnthropicUpReq,
  CustomAnthropicUpReq,
  AnthropicResponse,
  AnthropicResponse,
  ServerSentEvent,
  SSEMessage,
  CustomAnthropicStreamState
> = {
  name: "custom-anthropic",

  prepare: (req) => req,

  dispatch: async (up) => {
    const response = await buildUpstreamClient("custom-anthropic").send(up)
    if (isAnthropicNonStreaming(response)) {
      return { kind: "json", body: response }
    }
    return { kind: "stream", chunks: response }
  },

  adaptJson: (resp) => resp,

  initStreamState: () => ({ inputTokens: 0, outputTokens: 0 }),

  adaptChunk: (sseEvent, st) => {
    try {
      const parsed = JSON.parse(sseEvent.data)
      if (parsed.type === "message_delta" && parsed.usage) {
        st.inputTokens = parsed.usage.input_tokens ?? 0
        st.outputTokens = parsed.usage.output_tokens ?? 0
      }
    } catch {
      // Ignore parse errors for metrics
    }

    if (sseEvent.event) {
      return [{ event: sseEvent.event, data: sseEvent.data }]
    }
    return [{ data: sseEvent.data }]
  },

  adaptStreamError: () => {
    const errorEvent = translateErrorToAnthropicErrorEvent()
    return [{
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    }]
  },

  describeEndLog: (result) => {
    if (result.kind === "json") {
      return {
        model: result.req.payload.model,
        resolvedModel: result.req.payload.model,
        inputTokens: result.resp.usage?.input_tokens ?? 0,
        outputTokens: result.resp.usage?.output_tokens ?? 0,
        upstream: result.req.provider.name,
        upstreamFormat: result.req.provider.format,
      }
    }
    if (result.kind === "stream") {
      return {
        model: result.req.payload.model,
        inputTokens: result.state.inputTokens,
        outputTokens: result.state.outputTokens,
        upstream: result.req.provider.name,
        upstreamFormat: result.req.provider.format,
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
