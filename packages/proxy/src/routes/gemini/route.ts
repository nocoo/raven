import { Hono, type MiddlewareHandler } from "hono"
import { dispatch } from "../../composition"
import { resolveRouting } from "../../composition/routing"
import { buildContext } from "../../core/context"
import { logRequestError, logRequestStart, requestIdentity } from "../../core/request-log"
import { pickStrategy } from "../../core/router"
import { RoutingError } from "../../core/routing-types"
import { routingLog } from "../../core/routing-log"
import { projectCatalog } from "../../db/catalog"
import { ClientInputError, forwardError } from "../../lib/error"
import { getTokenCount } from "../../lib/tokenizer"
import { geminiToChat, parseGeminiRequest, parseGeminiTokenRequest } from "../../protocols/gemini/request"
import { geminiError } from "../../protocols/gemini/response"
import type { Model } from "../../services/copilot/get-models"
import { logEmitter } from "../../util/log-emitter"

export const geminiErrorResponses: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.res.status < 400) return
  const body = await c.res.json().catch(() => null) as { error?: { message?: unknown } } | null
  const message = typeof body?.error?.message === "string" ? body.error.message : "Gemini request failed"
  const headers = new Headers(c.res.headers)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  c.res = new Response(JSON.stringify(geminiError(c.res.status, message)), { status: c.res.status, headers })
}

export const geminiRoutes = new Hono()

function modelCatalog(c: Parameters<typeof buildContext>[0]) {
  return projectCatalog(c.get("routingDb")).filter(model => {
    const caps = model.capabilities as { type?: string } | undefined
    if (caps?.type && caps.type !== "chat") return false
    return !model.supported_endpoints?.length || model.supported_endpoints.some(path => path === "/chat/completions" || path === "/v1/chat/completions")
  }).map(model => ({
    name: `models/${model.id}`, baseModelId: model.id, displayName: model.display_name ?? model.name ?? model.id,
    ...(typeof model.max_input_tokens === "number" ? { inputTokenLimit: model.max_input_tokens } : {}),
    ...(typeof model.max_output_tokens === "number" ? { outputTokenLimit: model.max_output_tokens } : {}),
    supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
  }))
}

geminiRoutes.get("/", c => c.json({ models: modelCatalog(c) }))
geminiRoutes.get("/:model{.+}", c => {
  const model = modelCatalog(c).find(entry => entry.baseModelId === c.req.param("model"))
  return model ? c.json(model) : c.json(geminiError(404, "Model not found in Raven's cached catalog"), 404)
})

geminiRoutes.post("/:operation{.+}", async c => {
  const operation = c.req.param("operation")
  const split = operation.lastIndexOf(":")
  const model = operation.slice(0, split)
  const method = operation.slice(split + 1)
  const stream = method === "streamGenerateContent"
  const ctx = buildContext(c, "gemini", {}, stream)
  let dispatchOwnsLog = false
  try {
    if (split <= 0 || !["generateContent", "streamGenerateContent", "countTokens"].includes(method)) return c.json(geminiError(404, "Unknown Gemini operation"), 404)
    if (stream && c.req.query("alt") && c.req.query("alt") !== "sse") throw new ClientInputError("Gemini streaming requires alt=sse")
    let body: unknown
    try { body = await c.req.json() } catch { throw new ClientInputError("Invalid JSON") }
    const payload = method === "countTokens" ? parseGeminiTokenRequest(body, model) : parseGeminiRequest(body, model, stream)
    logRequestStart(ctx, model, { messageCount: payload.contents.length, toolCount: payload.tools?.flatMap(tool => tool.functionDeclarations).length ?? 0 })
    if (method !== "countTokens") {
      dispatchOwnsLog = true
      return await dispatch(c, ctx, payload, "gemini")
    }
    const selection = resolveRouting(c, ctx, model)
    const decision = pickStrategy({ protocol: "gemini", model: selection.resolved_model, requestedModel: model, provider: selection.upstream, allowConversion: selection.allow_conversion })
    if (decision.kind === "reject") throw new RoutingError(decision.message, decision.errorType, decision.status as 400 | 503)
    const metadata = selection.upstream.models.find(entry => entry.id === decision.model)
    if (!metadata?.capabilities) throw new RoutingError("Token estimation is unavailable for this model", "token_estimate_unavailable", 503)
    const counts = await getTokenCount(geminiToChat({ ...payload, model: decision.model }), metadata as unknown as Model)
    const totalTokens = counts.input + counts.output
    logEmitter.emitLog({ ts: Date.now(), level: "info", type: "request_end", requestId: ctx.requestId, msg: "200 Gemini token estimate",
      data: { ...requestIdentity(ctx), ...routingLog(ctx), estimatedInputTokens: totalTokens, estimationAvailable: true,
        latencyMs: Math.round(performance.now() - ctx.startTime), status: "success", statusCode: 200, upstreamStatus: null },
    })
    c.header("x-raven-token-count", "estimate")
    return c.json({ totalTokens })
  } catch (error) {
    if (!dispatchOwnsLog) logRequestError(ctx, error)
    return forwardError(c, error)
  }
})
