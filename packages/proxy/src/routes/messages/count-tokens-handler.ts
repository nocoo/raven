import type { Context } from "hono"
import { resolveRouting } from "../../composition/routing"
import { buildContext } from "../../core/context"
import { logRequestError, logRequestStart, requestIdentity } from "../../core/request-log"
import { routingLog } from "../../core/routing-log"
import { ClientInputError, forwardError } from "../../lib/error"
import { state } from "../../lib/state"
import { getTokenCount } from "../../lib/tokenizer"
import type { AnthropicMessagesPayload } from "../../protocols/anthropic/types"
import { resolveAgainstCatalog, translateModelName } from "../../protocols/anthropic/preprocess"
import { translateToOpenAI } from "../../protocols/translate/non-stream-translation"
import type { Model } from "../../services/copilot/get-models"
import { logEmitter } from "../../util/log-emitter"

export async function handleCountTokens(c: Context) {
  const ctx = buildContext(c, "anthropic")
  try {
    let payload: AnthropicMessagesPayload
    try { payload = await c.req.json<AnthropicMessagesPayload>() }
    catch { throw new ClientInputError("Invalid JSON") }
    if (!payload || typeof payload.model !== "string" || !payload.model.trim()) throw new ClientInputError("A model is required")
    logRequestStart(ctx, payload.model)
    const route = resolveRouting(c, ctx, payload.model)
    const model = route.upstream.kind === "copilot"
      ? resolveAgainstCatalog(translateModelName(route.resolved_model, ctx.anthropicBeta), route.upstream.models.map((entry) => entry.id))
      : route.resolved_model
    route.resolved_model = model
    const metadata = route.upstream.models.find((entry) => entry.id === model)
    let input_tokens = 1
    let estimationAvailable = false
    if (metadata?.capabilities && typeof metadata.capabilities === "object") {
      try {
        const translated = translateToOpenAI({ ...payload, model }, {
          anthropicBeta: ctx.anthropicBeta,
          sanitizeOrphanedToolResults: state.optSanitizeOrphanedToolResults,
          reorderToolResults: state.optReorderToolResults,
        })
        translated.model = model
        const tokens = await getTokenCount(translated, metadata as unknown as Model)
        const mcpTool = ctx.anthropicBeta?.startsWith("claude-code") && payload.tools?.some((tool) => tool.name.startsWith("mcp__"))
        if (payload.tools?.length && !mcpTool) {
          if (model.startsWith("claude")) tokens.input += 346
          else if (model.startsWith("grok")) tokens.input += 480
        }
        const adjustment = model.startsWith("claude") ? 1.15 : model.startsWith("grok") ? 1.03 : 1
        input_tokens = Math.round((tokens.input + tokens.output) * adjustment)
        estimationAvailable = true
      } catch { /* Estimation is optional and never contributes quota usage. */ }
    }
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId: ctx.requestId,
      msg: estimationAvailable ? "200 token estimate" : "200 token estimate unavailable",
      data: {
        ...requestIdentity(ctx), ...routingLog(ctx), resolvedModel: model, estimationAvailable,
        estimatedInputTokens: estimationAvailable ? input_tokens : null,
        latencyMs: Math.round(performance.now() - ctx.startTime), status: "success", statusCode: 200, upstreamStatus: null,
      },
    })
    return c.json({ input_tokens })
  } catch (error) {
    logRequestError(ctx, error)
    return forwardError(c, error)
  }
}
