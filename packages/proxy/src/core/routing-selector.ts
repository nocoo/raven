import { matchingInterval, normalizeIntervals } from "./schedule.ts"
import {
  RoutingError,
  type RoutingRule,
  type RoutingSelection,
  type RoutingSelectionInput,
  type RoutingTarget,
} from "./routing-types.ts"

export function getRoutingChain(rule: RoutingRule | null, now: number): { period_id: string | null; targets: RoutingTarget[] } {
  if (!rule) throw new RoutingError("Client key has no valid routing rule", "routing_configuration_error", 503)
  try {
    const periods = normalizeIntervals(rule.mode, rule.periods)
    const period = matchingInterval(rule.mode, periods, now)
    const targets = period?.targets ?? rule.default_chain
    if (!Array.isArray(targets) || !targets.length || targets.some((target) => !target
      || typeof target.upstream_id !== "string" || !target.upstream_id
      || typeof target.model !== "string" || !target.model.trim() || target.model === "auto")) {
      throw new Error("Invalid target chain")
    }
    return { period_id: period?.id ?? null, targets: structuredClone(targets) }
  } catch {
    throw new RoutingError("Routing rule contains an invalid schedule or target chain", "routing_configuration_error", 503)
  }
}

export function selectRoutingTarget(input: RoutingSelectionInput): RoutingSelection {
  if (!input.requested_model.trim()) throw new RoutingError("Model ID is required")
  const { period_id, targets } = getRoutingChain(input.rule, input.now)
  const skipped: RoutingSelection["skipped"] = []
  for (const target of targets) {
    const upstream = input.upstreams.find((entry) => entry.id === target.upstream_id)
    if (!upstream) throw new RoutingError(`Routing target upstream is missing: ${target.upstream_id}`, "routing_configuration_error", 503)
    const status = input.quota_status.get(upstream.id)
    if (upstream.quota !== null) {
      if (!status?.healthy || !status.window_id || !Number.isFinite(status.used_tokens) || status.used_tokens < 0
        || !Number.isFinite(upstream.quota.limit_tokens) || upstream.quota.limit_tokens <= 0
        || !Number.isFinite(status.multiplier) || status.multiplier <= 0) {
        throw new RoutingError(`Quota accounting is unavailable for ${upstream.id}`, "quota_accounting_unavailable", 503)
      }
      if (status.used_tokens >= upstream.quota.limit_tokens) {
        skipped.push({ upstream_id: upstream.id, reason: "quota_exhausted" })
        continue
      }
    }
    if (!upstream.is_enabled) throw new RoutingError(`Routing target upstream is disabled: ${upstream.id}`, "routing_configuration_error", 503)
    return {
      rule_id: input.rule!.id,
      period_id,
      allow_conversion: input.rule!.allow_conversion,
      requested_model: input.requested_model,
      resolved_model: input.requested_model === "auto" ? target.model : input.requested_model,
      upstream: structuredClone(upstream),
      quota: {
        upstream_id: upstream.id, window_id: upstream.quota === null ? null : status!.window_id,
        multiplier: upstream.quota === null ? 1 : status!.multiplier, captured_at: input.now,
      },
      skipped,
    }
  }
  throw new RoutingError("All configured targets have exhausted their quota", "quota_exhausted", 429)
}
