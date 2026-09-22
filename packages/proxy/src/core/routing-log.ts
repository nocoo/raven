import type { RequestContext } from "./context"

export interface RequestRoutingDetails {
  requested_model: string
  resolved_model: string
  rule_id: string
  period_id: string | null
  upstream_id: string
  upstream_name: string
  quota_window_id: string | null
  multiplier: number
  weighted_tokens: number
  usage_complete: boolean
  accounting_healthy: boolean
  admitted_at: number
  skipped: { upstream_id: string; reason: string }[]
  diagnostic: boolean
}

export function routingLog(ctx: RequestContext): Record<string, unknown> {
  const route = ctx.routing
  if (!route) return {}
  return {
    ...(ctx.upstreamProtocol ? { upstreamFormat: ctx.upstreamProtocol } : {}),
    routing: {
      requested_model: route.requested_model,
      resolved_model: route.resolved_model,
      rule_id: route.rule_id,
      period_id: route.period_id,
      upstream_id: route.upstream.id,
      upstream_name: route.upstream.name,
      quota_window_id: route.quota.window_id,
      multiplier: route.quota.multiplier,
      weighted_tokens: ctx.quotaUsage?.weighted_tokens ?? 0,
      usage_complete: ctx.quotaUsage?.complete ?? true,
      accounting_healthy: ctx.quotaUsage?.healthy ?? true,
      admitted_at: route.quota.captured_at,
      skipped: route.skipped,
      diagnostic: ctx.diagnostic ?? false,
    } satisfies RequestRoutingDetails,
    model: route.requested_model,
    requestedModel: route.requested_model,
    ruleId: route.rule_id,
    periodId: route.period_id,
    upstreamId: route.upstream.id,
    upstream: route.upstream.name,
    quotaWindowId: route.quota.window_id,
    quotaMultiplier: route.quota.multiplier,
    quotaWeightedTokens: ctx.quotaUsage?.weighted_tokens ?? 0,
    quotaUsageComplete: ctx.quotaUsage?.complete ?? true,
    quotaAccountingHealthy: ctx.quotaUsage?.healthy ?? true,
    quotaSkipped: route.skipped,
    admittedAt: ctx.admittedAt,
    diagnostic: ctx.diagnostic ?? false,
  }
}
