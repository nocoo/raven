import type { Context } from "hono"
import type { RequestContext } from "../core/context"
import { RoutingError, type QuotaStatus, type RoutingSelection } from "../core/routing-types"
import { selectRoutingTarget } from "../core/routing-selector"
import { listProviderRecords } from "../db/providers"
import { getRoutingRule } from "../db/routing-rules"
import { getQuotaStatus, recoverQuotaSettlements, settleQuota } from "../db/quota"
import type { UsageProtocol } from "../core/usage"
import { observeModelFetch } from "./usage-observer"
import { logEmitter } from "../util/log-emitter"

export function resolveRouting(c: Context, ctx: RequestContext, requestedModel: string): RoutingSelection {
  const db = c.get("routingDb")
  const ruleId = c.get("ruleId")
  if (!db || !ruleId) throw new RoutingError("The authenticated key has no routing rule", "routing_configuration_error", 503)
  const now = c.get("admittedAt") ?? Date.now()
  const rule = getRoutingRule(db, ruleId)
  const upstreams = listProviderRecords(db)
  const snapshots = new class extends Map<string, QuotaStatus> {
    override get(id: string): QuotaStatus {
      const cached = super.get(id)
      if (cached) return cached
      recoverQuotaSettlements(db, id)
      const status = getQuotaStatus(db, id, now)
      this.set(id, status)
      return status
    }
  }()
  const selection = selectRoutingTarget({ rule, requested_model: requestedModel, now, upstreams, quota_status: snapshots })
  ctx.routing = selection
  ctx.ruleId = ruleId
  ctx.admittedAt = now
  ctx.quotaUsage = { weighted_tokens: 0, complete: true, healthy: true }
  return selection
}

export function accountedFetch(c: Context, ctx: RequestContext, protocol: UsageProtocol): typeof fetch {
  const db = c.get("routingDb")
  const capture = ctx.routing!.quota
  return observeModelFetch(protocol, ({ attempt_ordinal, usage }) => {
    const settlement = settleQuota(db, { request_id: ctx.requestId, attempt_ordinal, capture, usage })
    if (settlement.error) logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "system", requestId: ctx.requestId,
      msg: "Quota settlement failed",
      data: {
        errorType: "quota_settlement_failed", error: settlement.error,
        upstreamId: capture.upstream_id, quotaWindowId: capture.window_id,
        attemptOrdinal: attempt_ordinal, weightedDebit: settlement.weighted_debit,
      },
    })
    if (ctx.quotaUsage) {
      ctx.quotaUsage.weighted_tokens += settlement.duplicate ? 0 : settlement.weighted_debit
      ctx.quotaUsage.complete &&= usage.complete
      ctx.quotaUsage.healthy &&= settlement.committed
    }
  })
}
