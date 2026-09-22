import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { accountedFetch, resolveRouting } from "../../src/composition/routing"
import { buildContext } from "../../src/core/context"
import { COPILOT_RULE_ID, type QuotaCapture } from "../../src/core/routing-types"
import { createProvider, updateProvider } from "../../src/db/providers"
import * as quota from "../../src/db/quota"
import { updateRoutingRule } from "../../src/db/routing-rules"
import { NOW, providerInput, quotaPolicy, routingFixture, ruleInput } from "../db/routing-fixture"

let fixture: ReturnType<typeof routingFixture>
const usage = { input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 2, complete: true }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request"))
})

afterEach(() => {
  fixture.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function capture(upstreamId: string): QuotaCapture {
  const status = quota.getQuotaStatus(fixture.db, upstreamId, NOW)
  return { upstream_id: upstreamId, window_id: status.window_id, multiplier: status.multiplier, captured_at: NOW }
}

function admissionApp() {
  return new Hono().get("/admit", (c) => {
    c.set("routingDb", fixture.db)
    c.set("ruleId", COPILOT_RULE_ID)
    const ctx = buildContext(c, "openai")
    const selected = resolveRouting(c, ctx, "auto")
    return c.json({ selected, admittedAt: ctx.admittedAt })
  })
}

describe("routing accounting admission", () => {
  test("recovers a retained debit once before checking repeated candidates against one shared snapshot", async () => {
    const upstream = createProvider(fixture.db, providerInput({ quota: quotaPolicy({ limit_tokens: 12 }) }))
    const terminal = createProvider(fixture.db, providerInput({ name: "Terminal" }))
    updateRoutingRule(fixture.db, COPILOT_RULE_ID, ruleInput({ default_chain: [
      { upstream_id: upstream.id, model: "first" },
      { upstream_id: upstream.id, model: "second" },
      { upstream_id: terminal.id, model: "terminal" },
    ] }))
    const retained = { request_id: "retained", attempt_ordinal: 0, capture: capture(upstream.id), usage }
    fixture.db.exec("CREATE TRIGGER fail_settlement BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    expect(quota.settleQuota(fixture.db, retained).committed).toBe(false)
    fixture.db.exec("DROP TRIGGER fail_settlement")
    const recovery = vi.spyOn(quota, "recoverQuotaSettlements")
    const status = vi.spyOn(quota, "getQuotaStatus")

    const response = await admissionApp().request("/admit")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      admittedAt: NOW,
      selected: {
        upstream: { id: terminal.id }, resolved_model: "terminal", quota: { captured_at: NOW },
        skipped: [
          { upstream_id: upstream.id, reason: "quota_exhausted" },
          { upstream_id: upstream.id, reason: "quota_exhausted" },
        ],
      },
    })
    expect(recovery.mock.calls.map((call) => call[1])).toEqual([upstream.id, terminal.id])
    expect(status.mock.calls.map((call) => call[1])).toEqual([upstream.id, terminal.id])
    expect(fixture.db.query("SELECT charged FROM quota_windows WHERE id = ?").get(retained.capture.window_id)).toEqual({ charged: 12 })
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 1 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("a disabled quota still attempts recovery and admits the target while a failed debit remains retained", async () => {
    const upstream = createProvider(fixture.db, providerInput({ quota: quotaPolicy() }))
    updateRoutingRule(fixture.db, COPILOT_RULE_ID, ruleInput({ default_chain: [{ upstream_id: upstream.id, model: "selected" }] }))
    const retained = { request_id: "retained", attempt_ordinal: 0, capture: capture(upstream.id), usage }
    fixture.db.exec("CREATE TRIGGER fail_settlement BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    expect(quota.settleQuota(fixture.db, retained).committed).toBe(false)
    updateProvider(fixture.db, upstream.id, { quota: null })
    const recovery = vi.spyOn(quota, "recoverQuotaSettlements")

    const response = await admissionApp().request("/admit")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ selected: { upstream: { id: upstream.id }, quota: { window_id: null }, skipped: [] } })
    expect(recovery).toHaveBeenCalledTimes(1)
    expect(recovery.mock.results[0]?.value).toBe(false)
    expect(quota.getQuotaStatus(fixture.db, upstream.id, NOW).healthy).toBe(false)
    fixture.db.exec("DROP TRIGGER fail_settlement")
    expect(quota.recoverQuotaSettlements(fixture.db, upstream.id)).toBe(true)
    expect(fixture.db.query("SELECT charged FROM quota_windows WHERE id = ?").get(retained.capture.window_id)).toEqual({ charged: 12 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test.each([true, false])("a previously committed attempt is not charged again with telemetry=%s", async (telemetry) => {
    const upstream = createProvider(fixture.db, providerInput({ quota: quotaPolicy() }))
    updateRoutingRule(fixture.db, COPILOT_RULE_ID, ruleInput({ default_chain: [{ upstream_id: upstream.id, model: "selected" }] }))
    const raw = { usage: { prompt_tokens: 10, completion_tokens: 2 } }
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json(raw))
    const app = new Hono().get("/attempt", async (c) => {
      c.set("routingDb", fixture.db)
      c.set("ruleId", COPILOT_RULE_ID)
      c.set("admittedAt", NOW)
      const ctx = buildContext(c, "openai")
      const selected = resolveRouting(c, ctx, "auto")
      expect(quota.settleQuota(fixture.db, { request_id: ctx.requestId, attempt_ordinal: 0, capture: selected.quota, usage }).committed).toBe(true)
      ctx.quotaUsage!.weighted_tokens = 12
      if (!telemetry) delete ctx.quotaUsage

      const observed = accountedFetch(c, ctx, "openai")
      expect(await (await observed("https://fixture.invalid", { method: "POST", body: "{}" })).json()).toEqual(raw)
      expect(ctx.quotaUsage?.weighted_tokens).toBe(telemetry ? 12 : undefined)
      return c.json({ used: quota.getQuotaStatus(fixture.db, upstream.id, NOW).used_tokens })
    })

    const response = await app.request("/attempt")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ used: 12 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 1 })
  })
})
