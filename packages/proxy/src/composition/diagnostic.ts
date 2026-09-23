import type { Database } from "bun:sqlite"
import type { Context } from "hono"
import { buildContext } from "../core/context"
import { pickStrategy, type ClientProtocol } from "../core/router"
import { nativeCapabilities } from "../core/protocol-capabilities"
import { RoutingError, type RoutingRule, type UpstreamDiagnostic, type UpstreamOperationDetails } from "../core/routing-types"
import { selectRoutingTarget } from "../core/routing-selector"
import { logRequestError, logRequestStart, requestIdentity } from "../core/request-log"
import { routingLog } from "../core/routing-log"
import { getProviderRecord } from "../db/providers"
import { getQuotaStatus, recoverQuotaSettlements } from "../db/quota"
import { logEmitter } from "../util/log-emitter"
import { ClientInputError, HTTPError } from "../lib/error"
import { Socks5BridgeUnavailableError } from "../lib/socks5-bridge"
import { captureOperationFetch, redactUpstreamText } from "../lib/upstream-operation"
import { buildStrategy } from "./strategy-registry"
import { accountedFetch } from "./routing"

function textBlocks(value: unknown, type: string): string {
  if (!Array.isArray(value)) return ""
  return value.map((block: unknown) => block && typeof block === "object" && "type" in block && block.type === type && "text" in block && typeof block.text === "string" ? block.text : "").join("")
}

function answerText(value: unknown, protocol: ClientProtocol): string {
  if (!value || typeof value !== "object") return ""
  const body = value as Record<string, unknown>
  if (protocol === "anthropic") return textBlocks(body.content, "text")
  if (protocol === "openai") {
    const content = (Array.isArray(body.choices) ? body.choices[0]?.message?.content : null) as unknown
    return typeof content === "string" ? content : textBlocks(content, "text")
  }
  if (typeof body.output_text === "string") return body.output_text
  return Array.isArray(body.output) ? body.output.map((item: unknown) => item && typeof item === "object" && "content" in item ? textBlocks(item.content, "output_text") : "").join("") : ""
}

export async function runUpstreamDiagnostic(c: Context, db: Database, id: string, model: string): Promise<UpstreamDiagnostic> {
  if (!model.trim() || model === "auto") throw new RoutingError("Choose an explicit model for the test")
  const now = Date.now()
  const upstream = getProviderRecord(db, id)
  if (!upstream) throw new RoutingError("Upstream not found", "not_found", 404)
  const protocol = nativeCapabilities(upstream, model, false)[0]?.protocol
  const ctx = buildContext(c, protocol ?? "openai")
  ctx.admittedAt = now
  ctx.diagnostic = true
  ctx.signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)])
  const details: UpstreamOperationDetails = { operation: "generation_test", request_id: ctx.requestId }
  const secrets = [upstream.api_key]
  c.set("routingDb", db)
  logRequestStart(ctx, model)
  try {
    recoverQuotaSettlements(db, id)
    const rule: RoutingRule = {
      id: "diagnostic", name: "Upstream diagnostic", allow_conversion: false,
      mode: "all_day", default_chain: [{ upstream_id: id, model }], periods: [],
      is_builtin: false, created_at: now, updated_at: now,
    }
    ctx.routing = selectRoutingTarget({
      rule, requested_model: model, now, upstreams: [upstream],
      quota_status: new Map([[id, getQuotaStatus(db, id, now)]]),
    })
    ctx.quotaUsage = { weighted_tokens: 0, complete: true, healthy: true }
    if (!protocol) throw new RoutingError("Refresh Copilot model capabilities before testing this model", "copilot_capabilities_unavailable", 503)
    const decision = pickStrategy({ protocol, provider: upstream, model, requestedModel: model, allowConversion: false })
    if (decision.kind === "reject") throw new RoutingError(decision.message, decision.errorType, decision.status as 400 | 503)
    ctx.routing.resolved_model = decision.model
    ctx.upstreamProtocol = decision.upstreamProtocol
    const strategy = buildStrategy(decision, {
      provider: upstream, toolCallDebug: false, allowEffortRepair: false,
      transport: { fetch: captureOperationFetch(details, secrets, accountedFetch(c, ctx, protocol)), allowReplay: false },
    })
    const messages = [{ role: "user", content: "ping. Reply with exactly pong." }]
    const body = protocol === "responses"
      ? { model: decision.model, input: "ping. Reply with exactly pong.", max_output_tokens: 32, stream: false }
      : protocol === "anthropic"
        ? { model: decision.model, messages, max_tokens: 32, stream: false }
        : { model: decision.model, messages, max_completion_tokens: 32, stream: false }
    const input = decision.name === "copilot-native"
      ? { payload: body, options: { copilotModel: decision.model, anthropicBeta: null }, originalModel: model }
      : decision.name === "custom-anthropic" || decision.name === "custom-openai"
        ? { provider: upstream, payload: body }
        : body
    const wire = strategy.prepare(input, ctx)
    const result = await strategy.dispatch(wire, ctx)
    if (result.kind !== "json") {
      await result.chunks[Symbol.asyncIterator]().return?.()
      throw new Error("The diagnostic returned an unexpected stream")
    }
    const rawAnswer = answerText(strategy.adaptJson(result.body, wire, ctx), protocol)
    const safeAnswer = redactUpstreamText(rawAnswer, secrets)
    const answer = safeAnswer.slice(0, 1024)
    const latency_ms = Math.round(performance.now() - ctx.startTime)
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId: ctx.requestId,
      msg: `200 diagnostic ${latency_ms}ms`,
      data: {
        ...requestIdentity(ctx), ...strategy.describeEndLog({ kind: "json", req: wire, resp: result.body }, ctx),
        ...routingLog(ctx), strategy: strategy.name, upstreamFormat: protocol,
        latencyMs: latency_ms, status: "success", statusCode: 200, upstreamStatus: 200,
      },
    })
    return { success: true, latency_ms, model: decision.model, protocol, answer, expected_pong: rawAnswer.trim().toLowerCase() === "pong", answer_truncated: safeAnswer.length > 1024, details }
  } catch (error) {
    const message = error instanceof SyntaxError ? "The upstream diagnostic did not return valid JSON" : redactUpstreamText(error instanceof Error ? error.message : String(error), secrets).slice(0, 512)
    const status = error instanceof HTTPError || error instanceof ClientInputError ? error.status : error instanceof SyntaxError || error instanceof Socks5BridgeUnavailableError ? 502 : 500
    const failure = error instanceof RoutingError
      ? new RoutingError(message, error.type, error.status, error.references, details)
      : new HTTPError(message, status, error instanceof HTTPError ? details.response_body : "", details)
    logRequestError(ctx, failure, { model, diagnostic: true })
    throw failure
  }
}
