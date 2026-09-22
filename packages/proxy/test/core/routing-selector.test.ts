import { describe, expect, test } from "vitest"
import { getRoutingChain, selectRoutingTarget } from "../../src/core/routing-selector.ts"
import type { QuotaStatus, RoutingRule, RoutingSelectionInput, UpstreamRecord } from "../../src/core/routing-types.ts"
import { RoutingError } from "../../src/core/routing-types.ts"
import { NOW, quotaPolicy } from "../db/routing-fixture.ts"

function upstream(id: string, limited = false): UpstreamRecord {
  return {
    id, name: id, kind: "custom", base_url: "https://fixture.invalid", api_key: "fixture-only", format: "responses",
    is_enabled: true, supports_reasoning: false, auth_style: null, use_socks5: null, manual_models: [], models: [],
    last_refreshed_at: null, last_refresh_error: null, quota: limited ? quotaPolicy() : null, created_at: NOW, updated_at: NOW,
  }
}
function status(used_tokens = 0): QuotaStatus {
  return { window_id: "window", starts_at: NOW, ends_at: NOW + 3600000, used_tokens, remaining_tokens: Math.max(0, 100 - used_tokens), limit_tokens: 100, multiplier: 0.5, healthy: true, usage_complete: true }
}
function input(): RoutingSelectionInput {
  const rule: RoutingRule = { id: "rule", name: "Rule", allow_conversion: false, is_builtin: false, mode: "all_day", periods: [], default_chain: [
    { upstream_id: "first", model: "first-configured" }, { upstream_id: "last", model: "terminal-configured" },
  ], created_at: NOW, updated_at: NOW }
  return { rule, now: NOW, requested_model: "auto", upstreams: [upstream("first", true), upstream("last")], quota_status: new Map([["first", status()]]) }
}

describe("pure key/time/quota target selection", () => {
  test("auto and an explicit raw model select the same upstream; only exact auto substitutes a model", () => {
    const snapshot = input()
    expect(selectRoutingTarget(snapshot)).toMatchObject({ rule_id: "rule", period_id: null, upstream: { id: "first" }, requested_model: "auto", resolved_model: "first-configured", allow_conversion: false, quota: { window_id: "window", multiplier: 0.5, captured_at: NOW } })
    for (const model of ["raw/not-in-catalog", "AUTO", " auto", "Auto"]) {
      expect(selectRoutingTarget({ ...snapshot, requested_model: model })).toMatchObject({ upstream: { id: "first" }, resolved_model: model })
    }
  })

  test("only exhaustion skips a candidate and restored allowance immediately resumes priority", () => {
    const snapshot = input()
    const exhausted = new Map([["first", status(100)]])
    expect(selectRoutingTarget({ ...snapshot, quota_status: exhausted })).toMatchObject({ upstream: { id: "last" }, resolved_model: "terminal-configured", skipped: [{ upstream_id: "first", reason: "quota_exhausted" }], quota: { window_id: null, multiplier: 1 } })
    expect(selectRoutingTarget(snapshot).upstream.id).toBe("first")
    expect(selectRoutingTarget({ ...snapshot, quota_status: new Map([["first", status(99.5)]]) }).upstream.id).toBe("first")
  })

  test("terminal fallback has no Copilot privilege and is itself quota constrained", () => {
    const snapshot = input()
    snapshot.upstreams = [upstream("first", true), upstream("last", true), upstream("builtin:copilot")]
    snapshot.quota_status = new Map([["first", status(100)], ["last", status(150)]])
    expect(() => selectRoutingTarget(snapshot)).toThrow(expect.objectContaining({ status: 429, type: "quota_exhausted" }))
  })

  test("uses period chains, exact boundaries, and the visible default only in gaps", () => {
    const snapshot = input()
    snapshot.rule = { ...snapshot.rule!, mode: "daily", periods: [
      { id: "first-period", start_minute: 0, end_minute: 30, targets: [{ upstream_id: "last", model: "period-model" }] },
      { id: "adjacent", start_minute: 30, end_minute: 60, targets: [{ upstream_id: "last", model: "period-model" }] },
    ] }
    expect(selectRoutingTarget(snapshot)).toMatchObject({ period_id: "first-period", resolved_model: "period-model", upstream: { id: "last" } })
    expect(selectRoutingTarget({ ...snapshot, now: NOW + 30 * 60000 }).period_id).toBe("adjacent")
    expect(selectRoutingTarget({ ...snapshot, now: NOW + 60 * 60000 })).toMatchObject({ period_id: null, upstream: { id: "first" } })
    snapshot.rule = { ...snapshot.rule, mode: "weekly", periods: [{ id: "sunday-night", start_minute: 10020, end_minute: 30, targets: [{ upstream_id: "last", model: "night" }] }] }
    expect(selectRoutingTarget(snapshot).period_id).toBe("sunday-night")
    expect(selectRoutingTarget({ ...snapshot, now: NOW - 30 * 60000 }).period_id).toBe("sunday-night")
  })

  test("running selections retain independent snapshots when rule, upstream, key binding or quota edits arrive", () => {
    const snapshot = input()
    const selected = selectRoutingTarget(snapshot)
    snapshot.rule!.id = "new-binding"
    snapshot.rule!.default_chain[0]!.model = "edited-model"
    snapshot.upstreams[0]!.api_key = "edited-fixture"
    snapshot.upstreams[0]!.quota!.limit_tokens = 1
    snapshot.quota_status = new Map([["first", { ...status(), window_id: "new-window", multiplier: 2 }]])
    expect(selected).toMatchObject({ rule_id: "rule", resolved_model: "first-configured", upstream: { api_key: "fixture-only", quota: { limit_tokens: 100 } }, quota: { window_id: "window", multiplier: 0.5 } })
    expect(selectRoutingTarget(snapshot)).toMatchObject({ rule_id: "new-binding", resolved_model: "edited-model", quota: { window_id: "new-window", multiplier: 2 } })
  })

  test.each([
    undefined, { ...status(), healthy: false }, { ...status(200), healthy: false }, { ...status(), window_id: null },
    { ...status(), used_tokens: Number.NaN }, { ...status(), used_tokens: -1 },
    { ...status(), multiplier: 0 }, { ...status(), multiplier: Number.POSITIVE_INFINITY },
  ])("enabled quotas fail closed on unavailable accounting without skipping: %j", (quota) => {
    const snapshot = input()
    snapshot.quota_status = quota ? new Map([["first", quota]]) : new Map()
    expect(() => selectRoutingTarget(snapshot)).toThrow(expect.objectContaining({ status: 503, type: "quota_accounting_unavailable" }))
  })

  test("incomplete usage is visible but does not block soft quotas; disabled quotas ignore ledger health", () => {
    const snapshot = input()
    snapshot.quota_status = new Map([["first", { ...status(), usage_complete: false }]])
    expect(selectRoutingTarget(snapshot).upstream.id).toBe("first")
    snapshot.upstreams[0]!.quota = null
    snapshot.quota_status = new Map([["first", { ...status(), healthy: false }]])
    expect(selectRoutingTarget(snapshot)).toMatchObject({ upstream: { id: "first" }, quota: { window_id: null, multiplier: 1 } })
  })

  test("missing or disabled selected upstreams are configuration errors, never quota skips", () => {
    const snapshot = input()
    expect(() => selectRoutingTarget({ ...snapshot, upstreams: [upstream("last")] })).toThrow(expect.objectContaining({ type: "routing_configuration_error" }))
    snapshot.upstreams[0]!.is_enabled = false
    expect(() => selectRoutingTarget(snapshot)).toThrow(expect.objectContaining({ type: "routing_configuration_error" }))
    snapshot.quota_status = new Map([["first", status(100)]])
    expect(selectRoutingTarget(snapshot).upstream.id).toBe("last")
    snapshot.upstreams[1]!.is_enabled = false
    expect(() => selectRoutingTarget(snapshot)).toThrow("disabled")
  })

  test("rejects missing/corrupt binding, invalid chains, schedules and allowances locally", () => {
    expect(() => selectRoutingTarget({ ...input(), rule: null })).toThrow(expect.objectContaining({ type: "routing_configuration_error" }))
    expect(() => selectRoutingTarget({ ...input(), requested_model: " " })).toThrow("Model ID is required")
    for (const chain of [[], null, [null], [{ upstream_id: "", model: "model" }], [{ upstream_id: "first", model: "auto" }], [{ upstream_id: "first", model: "" }]]) {
      const snapshot = input()
      snapshot.rule!.default_chain = chain as any
      expect(() => selectRoutingTarget(snapshot)).toThrow(RoutingError)
    }
    const corrupt = input()
    corrupt.rule!.mode = "invalid" as any
    expect(() => getRoutingChain(corrupt.rule, NOW)).toThrow("invalid schedule")
    for (const limit of [0, -1, Number.POSITIVE_INFINITY]) {
      const snapshot = input()
      snapshot.upstreams[0]!.quota!.limit_tokens = limit
      expect(() => selectRoutingTarget(snapshot)).toThrow("accounting is unavailable")
    }
  })
})
