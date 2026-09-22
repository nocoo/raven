import type { Database } from "bun:sqlite"
import type { Context } from "hono"
import { buildContext } from "../core/context"
import { declaredProtocols, formatProtocol, pickStrategy, type ClientProtocol } from "../core/router"
import { RoutingError, type RoutingRule } from "../core/routing-types"
import { selectRoutingTarget } from "../core/routing-selector"
import { logRequestError, logRequestStart, requestIdentity } from "../core/request-log"
import { routingLog } from "../core/routing-log"
import { getProviderRecord } from "../db/providers"
import { getQuotaStatus, recoverQuotaSettlements } from "../db/quota"
import { logEmitter } from "../util/log-emitter"
import { buildStrategy } from "./strategy-registry"
import { accountedFetch } from "./routing"

function answerText(value: unknown, protocol: ClientProtocol): string {
  const body = value as {
    content?: { type: string; text?: string }[]
    choices?: { message?: { content?: string } }[]
    output_text?: string
    output?: { content?: { type: string; text?: string }[] }[]
  }
  if (protocol === "anthropic") return body.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") ?? ""
  if (protocol === "openai") return body.choices?.[0]?.message?.content ?? ""
  return body.output_text ?? body.output?.flatMap((item) => item.content ?? []).filter((b) => b.type === "output_text").map((b) => b.text ?? "").join("") ?? ""
}

export async function runUpstreamDiagnostic(c: Context, db: Database, id: string, model: string) {
  if (!model.trim() || model === "auto") throw new RoutingError("Choose an explicit model for the test")
  const now = Date.now()
  const upstream = getProviderRecord(db, id)
  if (!upstream) throw new RoutingError("Upstream not found", "not_found", 404)
  const protocol = upstream.kind === "copilot"
    ? declaredProtocols(upstream.models.find((m) => m.id === model))[0]
    : upstream.format ? formatProtocol(upstream.format) : undefined
  const ctx = buildContext(c, protocol ?? "openai")
  ctx.admittedAt = now
  ctx.diagnostic = true
  ctx.signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)])
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
      transport: { fetch: accountedFetch(c, ctx, protocol), allowReplay: false },
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
    const answer = answerText(strategy.adaptJson(result.body, wire, ctx), protocol).slice(0, 1024)
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
    return { success: true, latency_ms, model: decision.model, protocol, answer, expected_pong: answer.trim().toLowerCase() === "pong" }
  } catch (error) {
    logRequestError(ctx, error, { model, diagnostic: true })
    throw error
  }
}
