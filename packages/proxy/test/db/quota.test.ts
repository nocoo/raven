import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { selectRoutingTarget } from "../../src/core/routing-selector.ts"
import type { NormalizedQuotaUsage, QuotaCapture, QuotaSettlementInput } from "../../src/core/routing-types.ts"
import { createApiKey, validateApiKey } from "../../src/db/keys.ts"
import { createProvider, deleteProvider, getProvider, getProviderRecord, listProviderRecords, updateProvider } from "../../src/db/providers.ts"
import { getQuotaStatus, recoverQuotaSettlements, saveQuotaPolicy, settleQuota } from "../../src/db/quota.ts"
import { initRouting } from "../../src/db/routing-migration.ts"
import { createRoutingRule, getRoutingRule } from "../../src/db/routing-rules.ts"
import { HOUR, NOW, providerInput, quotaPolicy, routingFixture, ruleInput } from "./routing-fixture.ts"

let fixture: ReturnType<typeof routingFixture>
let db: Database
let upstreamId: string
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  db = fixture.db
  upstreamId = createProvider(db, providerInput({ quota: quotaPolicy() })).id
})
afterEach(() => { fixture.close(); vi.useRealTimers() })

function capture(id = upstreamId, now = Date.now()): QuotaCapture {
  const status = getQuotaStatus(db, id, now)
  return { upstream_id: id, window_id: status.window_id, multiplier: status.multiplier, captured_at: now }
}
function usage(input_tokens: number | null, output_tokens: number | null = 0): NormalizedQuotaUsage {
  return { input_tokens, output_tokens, cache_read_tokens: null, cache_write_tokens: null, complete: input_tokens !== null && output_tokens !== null }
}
function settlement(request_id: string, tokens: number | null = 1, locked = capture(), attempt_ordinal = 0): QuotaSettlementInput {
  return { request_id, attempt_ordinal, capture: locked, usage: usage(tokens) }
}
function charged(windowId: string | null): number {
  return (db.query("SELECT charged FROM quota_windows WHERE id = ?").get(windowId) as { charged: number }).charged
}

describe("shared fractional quota windows", () => {
  test("multiple keys, rules and explicit models share upstream allowance and resume priority after reset", () => {
    const fallback = createProvider(db, providerInput({ name: "Terminal" }))
    const default_chain = [{ upstream_id: upstreamId, model: "configured" }, { upstream_id: fallback.id, model: "terminal" }]
    const firstRule = createRoutingRule(db, ruleInput({ default_chain }))
    const secondRule = createRoutingRule(db, ruleInput({ name: "Other", default_chain }))
    const keys = [createApiKey(db, "One", firstRule.id), createApiKey(db, "Two", secondRule.id)]
    const choose = (key: string, model: string) => selectRoutingTarget({
      rule: getRoutingRule(db, validateApiKey(db, key)!.rule_id), requested_model: model, now: Date.now(),
      upstreams: listProviderRecords(db), quota_status: new Map([[upstreamId, getQuotaStatus(db, upstreamId)]]),
    })
    const one = choose(keys[0]!.key, "auto")
    const two = choose(keys[1]!.key, "explicit/never-listed")
    expect([one.upstream.id, two.upstream.id]).toEqual([upstreamId, upstreamId])
    settleQuota(db, settlement("one", 60, one.quota))
    settleQuota(db, settlement("two", 50, two.quota))
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ used_tokens: 110, remaining_tokens: 0 })
    expect(choose(keys[0]!.key, "auto").upstream.id).toBe(fallback.id)
    db = fixture.reopen()
    expect(getQuotaStatus(db, upstreamId).used_tokens).toBe(110)
    vi.setSystemTime(NOW + HOUR)
    expect(choose(keys[1]!.key, "auto").upstream.id).toBe(upstreamId)
    expect(getQuotaStatus(db, upstreamId).used_tokens).toBe(0)
  })

  test("fractional debits and inclusive-input normalization remain exact; output reasoning is not added twice", () => {
    const locked = { ...capture(), multiplier: 0.5 }
    expect(settleQuota(db, settlement("half", 1, locked)).weighted_debit).toBe(0.5)
    const observed: NormalizedQuotaUsage = { input_tokens: 200, cache_read_tokens: 800, cache_write_tokens: null, output_tokens: 100, complete: true, usage_present: true }
    expect(settleQuota(db, { request_id: "responses", attempt_ordinal: 0, capture: { ...locked, multiplier: 1 }, usage: observed }).weighted_debit).toBe(1100)
    expect(settleQuota(db, { request_id: "anthropic", attempt_ordinal: 0, capture: { ...locked, multiplier: 2 }, usage: { ...observed, input_tokens: 10, cache_read_tokens: 20, cache_write_tokens: 30, output_tokens: 40 } }).weighted_debit).toBe(200)
    expect(charged(locked.window_id)).toBe(1300.5)
  })

  test("distinct attempts and two SQLite connections atomically increment while duplicate completions do nothing", async () => {
    const locked = capture()
    const other = new Database(fixture.path)
    try {
      initRouting(other)
      const observations = [getQuotaStatus(db, upstreamId), getQuotaStatus(other, upstreamId)]
      expect(observations.map((status) => status.used_tokens)).toEqual([0, 0])
      const outcomes = await Promise.all([
        Promise.resolve().then(() => settleQuota(db, settlement("request", 11, locked, 0))),
        Promise.resolve().then(() => settleQuota(other, settlement("request", 12, locked, 1))),
        Promise.resolve().then(() => settleQuota(db, settlement("request", 13, locked, 2))),
      ])
      expect(outcomes.every((outcome) => outcome.committed)).toBe(true)
      expect(settleQuota(other, settlement("request", 12, locked, 1))).toMatchObject({ committed: true, duplicate: true })
      expect(charged(locked.window_id)).toBe(36)
      expect(db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 3 })
    } finally { other.close() }
  })

  test("skipped cycles create one current window and late completion debits only its captured old ID", () => {
    const old = capture()
    settleQuota(db, settlement("before", 20, old))
    vi.setSystemTime(NOW + 5 * HOUR + 12345)
    const current = getQuotaStatus(db, upstreamId)
    expect(current).toMatchObject({ starts_at: NOW + 5 * HOUR, ends_at: NOW + 6 * HOUR, used_tokens: 0 })
    expect(db.query("SELECT COUNT(*) AS count FROM quota_windows").get()).toEqual({ count: 2 })
    expect(settleQuota(db, settlement("late", 17, old)).committed).toBe(true)
    expect(charged(old.window_id)).toBe(37)
    expect(charged(current.window_id)).toBe(0)
    db = fixture.reopen()
    expect(getQuotaStatus(db, upstreamId).window_id).toBe(current.window_id)
    expect(charged(old.window_id)).toBe(37)
  })

  test("limit and multiplier edits retain debits and in-flight multipliers, including schedule gaps", () => {
    updateProvider(db, upstreamId, { quota: quotaPolicy({ mode: "daily", multipliers: [{ id: "half", start_minute: 0, end_minute: 30, multiplier: 0.5 }] }) })
    const old = capture()
    settleQuota(db, settlement("before", 10, old))
    updateProvider(db, upstreamId, { quota: quotaPolicy({ limit_tokens: 200, mode: "weekly", multipliers: [{ id: "double", start_minute: 0, end_minute: 30, multiplier: 2 }] }) })
    const next = capture()
    expect(next.window_id).toBe(old.window_id)
    expect(next.multiplier).toBe(2)
    settleQuota(db, settlement("old-running", 1, old))
    settleQuota(db, settlement("new", 1, next))
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ used_tokens: 7.5, remaining_tokens: 192.5, limit_tokens: 200 })
    expect(getQuotaStatus(db, upstreamId, NOW + 30 * 60000).multiplier).toBe(1)
    updateProvider(db, upstreamId, { quota: quotaPolicy({ limit_tokens: 5 }) })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ used_tokens: 7.5, remaining_tokens: 0 })
  })

  test("future recalibration changes only active end and later duration; past reset retires without losing late debits", () => {
    const old = capture()
    settleQuota(db, settlement("before", 10, old))
    updateProvider(db, upstreamId, { quota: quotaPolicy({ window_minutes: 120, next_reset_at: NOW + 3 * HOUR }) })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ window_id: old.window_id, starts_at: NOW, ends_at: NOW + 3 * HOUR, used_tokens: 10 })
    vi.setSystemTime(NOW + 3 * HOUR)
    const next = capture()
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ starts_at: NOW + 3 * HOUR, ends_at: NOW + 5 * HOUR, used_tokens: 0 })
    settleQuota(db, settlement("new-before-edit", 3, next))
    updateProvider(db, upstreamId, { quota: quotaPolicy({ window_minutes: 60, next_reset_at: NOW + 30 * 60000 }) })
    const recalibrated = getQuotaStatus(db, upstreamId)
    expect(recalibrated).toMatchObject({ starts_at: NOW + 2.5 * HOUR, ends_at: NOW + 3.5 * HOUR, used_tokens: 0 })
    expect(recalibrated.window_id).not.toBe(next.window_id)
    settleQuota(db, settlement("late-oldest", 2, old))
    settleQuota(db, settlement("late-edited", 4, next))
    expect(charged(old.window_id)).toBe(12)
    expect(charged(next.window_id)).toBe(7)
    expect(charged(recalibrated.window_id)).toBe(0)
  })

  test("editing a past reset after downtime does not manufacture intermediate windows", () => {
    vi.setSystemTime(NOW + 10 * HOUR)
    updateProvider(db, upstreamId, { quota: quotaPolicy({ next_reset_at: NOW + 30 * 60000 }) })
    expect(db.query("SELECT COUNT(*) AS count FROM quota_windows").get()).toEqual({ count: 2 })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ starts_at: NOW + 9.5 * HOUR, ends_at: NOW + 10.5 * HOUR })
  })

  test("newly enabled and reenabled quotas start at enable time with an irregular first window", () => {
    updateProvider(db, upstreamId, { quota: null })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ window_id: null, limit_tokens: null, remaining_tokens: null, multiplier: 1 })
    vi.setSystemTime(NOW + 15 * 60000)
    updateProvider(db, upstreamId, { quota: quotaPolicy() })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ starts_at: NOW + 15 * 60000, ends_at: NOW + HOUR })
    expect(getProvider(db, upstreamId)?.quota?.next_reset_at).toBe(NOW + HOUR)
    vi.setSystemTime(NOW + 5 * HOUR)
    const policy = getProviderRecord(db, upstreamId)!.quota!
    updateProvider(db, upstreamId, { quota: { ...policy, limit_tokens: 50 } })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ starts_at: NOW + 5 * HOUR, ends_at: NOW + 6 * HOUR })
  })

  test("absent, empty, partial and explicit-zero usage remain distinct and incomplete accounting is durable", () => {
    const locked = capture()
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, complete: true, usage_present: true }
    settleQuota(db, { request_id: "zero", attempt_ordinal: 0, capture: locked, usage: zero })
    expect(getQuotaStatus(db, upstreamId).usage_complete).toBe(true)
    const empty = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, complete: false }
    settleQuota(db, { request_id: "absent", attempt_ordinal: 0, capture: locked, usage: { ...empty, usage_present: false } })
    settleQuota(db, { request_id: "empty-object", attempt_ordinal: 0, capture: locked, usage: { ...empty, usage_present: true } })
    settleQuota(db, { request_id: "partial", attempt_ordinal: 0, capture: locked, usage: { ...empty, output_tokens: 5 } })
    expect(db.query("SELECT request_id, usage_present, usage_complete, input_tokens, weighted_debit FROM quota_settlements ORDER BY request_id").all()).toEqual([
      { request_id: "absent", usage_present: 0, usage_complete: 0, input_tokens: null, weighted_debit: 0 },
      { request_id: "empty-object", usage_present: 1, usage_complete: 0, input_tokens: null, weighted_debit: 0 },
      { request_id: "partial", usage_present: 1, usage_complete: 0, input_tokens: null, weighted_debit: 5 },
      { request_id: "zero", usage_present: 1, usage_complete: 1, input_tokens: 0, weighted_debit: 0 },
    ])
    db = fixture.reopen()
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ healthy: true, usage_complete: false, used_tokens: 5 })
    vi.setSystemTime(NOW + HOUR)
    expect(getQuotaStatus(db, upstreamId).usage_complete).toBe(true)
  })

  test("a captured window outlives provider deletion", () => {
    const old = capture()
    deleteProvider(db, upstreamId)
    expect(settleQuota(db, settlement("already-in-flight", 9, old)).committed).toBe(true)
    expect(charged(old.window_id)).toBe(9)
    expect(() => getQuotaStatus(db, upstreamId)).toThrow("not found")
    expect(() => saveQuotaPolicy(db, upstreamId, null)).toThrow("not found")
  })
})

describe("atomic accounting failure and local recovery", () => {
  test("failed aggregate update rolls back the inserted debit and retains a recoverable latch", () => {
    const input = settlement("atomic", 5)
    db.exec("CREATE TRIGGER block_debit BEFORE UPDATE OF charged ON quota_windows BEGIN SELECT RAISE(ABORT, 'simulated aggregate failure'); END")
    const result = settleQuota(db, input)
    expect(result).toMatchObject({ committed: false, duplicate: false, weighted_debit: 5, error: "simulated aggregate failure" })
    expect(db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 0 })
    expect(charged(input.capture.window_id)).toBe(0)
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(false)
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(false)
    db.exec("DROP TRIGGER block_debit")
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(true)
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ healthy: true, used_tokens: 5 })
    expect(settleQuota(db, input)).toMatchObject({ committed: true, duplicate: true })
  })

  test("an actual SQLite lock retains the failed write and recovery performs no upstream action", () => {
    const input = settlement("locked", 7)
    const other = new Database(fixture.path)
    try {
      initRouting(other)
      db.exec("PRAGMA busy_timeout = 1")
      other.exec("BEGIN IMMEDIATE")
      expect(settleQuota(db, input).committed).toBe(false)
      expect(getQuotaStatus(db, upstreamId).healthy).toBe(false)
      other.exec("ROLLBACK")
      expect(recoverQuotaSettlements(db, upstreamId)).toBe(true)
      expect(charged(input.capture.window_id)).toBe(7)
    } finally { other.close() }
  })

  test("unrelated successful settlements and partial recovery cannot clear pending failures", () => {
    db.exec(`CREATE TRIGGER fail_first BEFORE INSERT ON quota_settlements WHEN NEW.request_id = 'first' BEGIN SELECT RAISE(ABORT, 'first fault'); END;
      CREATE TRIGGER fail_second BEFORE INSERT ON quota_settlements WHEN NEW.request_id = 'second' BEGIN SELECT RAISE(ABORT, 'second fault'); END`)
    settleQuota(db, settlement("first", 5))
    settleQuota(db, settlement("second", 7))
    expect(settleQuota(db, settlement("unrelated", 11)).committed).toBe(true)
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(false)
    expect(recoverQuotaSettlements(db, "another-upstream")).toBe(true)
    db.exec("DROP TRIGGER fail_first")
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(false)
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ healthy: false, used_tokens: 16 })
    db.exec("DROP TRIGGER fail_second")
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(true)
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(true)
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ healthy: true, used_tokens: 23 })
  })

  test("enabled quota blocks without skipping, disabled quota admits while retaining failed recovery", () => {
    const locked = capture()
    const rule = createRoutingRule(db, ruleInput({ default_chain: [{ upstream_id: upstreamId, model: "first" }, ...ruleInput().default_chain] }))
    db.exec("CREATE TRIGGER block_all BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'storage fault'); END")
    settleQuota(db, settlement("failed", 3, locked))
    const select = () => selectRoutingTarget({ rule, now: Date.now(), requested_model: "auto", upstreams: listProviderRecords(db), quota_status: new Map([[upstreamId, getQuotaStatus(db, upstreamId)]]) })
    expect(() => select()).toThrow(expect.objectContaining({ type: "quota_accounting_unavailable", status: 503 }))
    updateProvider(db, upstreamId, { quota: null })
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(false)
    expect(select()).toMatchObject({ upstream: { id: upstreamId }, quota: { window_id: null, multiplier: 1 } })
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(false)
    db.exec("DROP TRIGGER block_all")
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(true)
    expect(charged(locked.window_id)).toBe(3)
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(true)
    const noQuota = capture()
    settleQuota(db, { request_id: "disabled-absent", attempt_ordinal: 0, capture: noQuota, usage: { ...usage(null, null), usage_present: false } })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ healthy: true, usage_complete: false })
  })

  test("pending snapshots are immutable and a direct successful retry clears only its own entry", () => {
    const input = settlement("immutable", 4)
    db.exec("CREATE TRIGGER block_one BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'fault'); END")
    settleQuota(db, input)
    settleQuota(db, input)
    input.usage.input_tokens = 999
    db.exec("DROP TRIGGER block_one")
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(true)
    expect(charged(input.capture.window_id)).toBe(4)
    db.exec("CREATE TRIGGER block_two BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'fault'); END")
    const next = settlement("direct-retry", 6)
    settleQuota(db, next)
    db.exec("DROP TRIGGER block_two")
    expect(settleQuota(db, next).committed).toBe(true)
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(true)
    expect(charged(next.capture.window_id)).toBe(10)
  })

  test("a direct retry after reset settles the retained snapshot even if the caller mutated its capture and usage", () => {
    const input = settlement("retry-after-reset", 4)
    const admitted = structuredClone(input)
    db.exec("CREATE TRIGGER block_retry BEFORE INSERT ON quota_settlements BEGIN SELECT RAISE(ABORT, 'temporary failure'); END")
    expect(settleQuota(db, input).committed).toBe(false)
    vi.setSystemTime(NOW + HOUR)
    const current = capture()
    input.capture = { ...current, multiplier: 2 }
    input.usage.input_tokens = 999
    db.exec("DROP TRIGGER block_retry")
    expect(settleQuota(db, input)).toMatchObject({ committed: true, weighted_debit: 4 })
    expect(charged(admitted.capture.window_id)).toBe(4)
    expect(charged(current.window_id)).toBe(0)
    expect(db.query("SELECT window_id, captured_at, multiplier, input_tokens FROM quota_settlements WHERE request_id = ?").get(input.request_id)).toEqual({
      window_id: admitted.capture.window_id, captured_at: NOW, multiplier: 1, input_tokens: 4,
    })
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(true)
  })

  test("an unreadable ledger or corrupt window fails accounting instead of restoring allowance", () => {
    db.exec("ALTER TABLE quota_settlements RENAME TO hidden_settlements")
    updateProvider(db, upstreamId, { quota: null })
    expect(getQuotaStatus(db, upstreamId)).toMatchObject({ healthy: false, usage_complete: false })
    db.exec("ALTER TABLE hidden_settlements RENAME TO quota_settlements")
    updateProvider(db, upstreamId, { quota: quotaPolicy() })
    db.exec("PRAGMA ignore_check_constraints = ON")
    db.query("UPDATE quota_windows SET ends_at = starts_at").run()
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(false)
    expect(() => saveQuotaPolicy(db, upstreamId, quotaPolicy({ limit_tokens: 200 }))).toThrow("Invalid stored quota window")
    db.exec("PRAGMA ignore_check_constraints = OFF")
    db.query("UPDATE providers SET quota_window_id = 'nonexistent' WHERE id = ?").run(upstreamId)
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(false)
  })

  test("settlement cannot attach another upstream to a captured window and rolls back on mismatch", () => {
    const input = settlement("wrong-upstream", 10)
    input.capture.upstream_id = "different"
    expect(settleQuota(db, input)).toMatchObject({ committed: false, error: "Captured quota window is unavailable" })
    expect(db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 0 })
  })

  test("validates internal settlement identity and finite nonnegative observed tokens before writing", () => {
    expect(recoverQuotaSettlements(db, upstreamId)).toBe(true)
    for (const invalid of [
      { request_id: "" }, { attempt_ordinal: -1 }, { attempt_ordinal: 0.5 },
      { capture: { ...capture(), upstream_id: "" } }, { capture: { ...capture(), captured_at: Number.NaN } },
      { capture: { ...capture(), multiplier: 0 } }, { capture: { ...capture(), multiplier: Number.POSITIVE_INFINITY } },
      { usage: usage(-1) }, { usage: usage(Number.NaN) }, { usage: usage(Number.POSITIVE_INFINITY) },
      { usage: usage(Number.MAX_VALUE), capture: { ...capture(), multiplier: 2 } },
    ]) expect(() => settleQuota(db, { ...settlement("invalid"), ...invalid })).toThrow()
    expect(db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 0 })
    expect(getQuotaStatus(db, upstreamId).healthy).toBe(true)
  })
})
