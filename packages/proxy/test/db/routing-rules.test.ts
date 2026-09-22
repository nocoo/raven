import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_RULE_ID, RoutingError } from "../../src/core/routing-types.ts"
import { createRoutingRule, deleteRoutingRule, getRoutingRule, listRoutingRules, updateRoutingRule } from "../../src/db/routing-rules.ts"
import { createProvider } from "../../src/db/providers.ts"
import { NOW, providerInput, routingFixture, ruleInput } from "./routing-fixture.ts"

let fixture: ReturnType<typeof routingFixture>
let db: Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  db = fixture.db
})
afterEach(() => { fixture.close(); vi.useRealTimers() })

describe("routing rule repository", () => {
  test("defaults new conversion off, persists exact targets and preserves built-in identity", () => {
    const upstream = createProvider(db, providerInput())
    const rule = createRoutingRule(db, ruleInput({ default_chain: [{ upstream_id: upstream.id, model: "typed/model-not-in-catalog" }] }))
    expect(rule).toMatchObject({ allow_conversion: false, is_builtin: false, created_at: NOW, updated_at: NOW })
    vi.setSystemTime(NOW + 1)
    const updated = updateRoutingRule(db, rule.id, ruleInput({ allow_conversion: true, name: "Updated" }))
    expect(updated).toMatchObject({ id: rule.id, allow_conversion: true, name: "Updated", created_at: NOW, updated_at: NOW + 1 })
    updateRoutingRule(db, rule.id, ruleInput())
    expect(getRoutingRule(db, rule.id)?.allow_conversion).toBe(true)
    expect(listRoutingRules(db).map((entry) => entry.id)).toEqual([COPILOT_RULE_ID, rule.id])
    expect(() => deleteRoutingRule(db, COPILOT_RULE_ID)).toThrow("protected")
    expect(deleteRoutingRule(db, "missing")).toBe(false)
    expect(getRoutingRule(db, "missing")).toBeNull()
    expect(updateRoutingRule(db, "missing", ruleInput())).toBeNull()
    expect(deleteRoutingRule(db, rule.id)).toBe(true)
  })

  test("normalizes overnight fragments without merging adjacent logical identities", () => {
    const targets = ruleInput().default_chain
    const rule = createRoutingRule(db, ruleInput({ mode: "daily", periods: [
      { id: "night", start_minute: 1380, end_minute: 60, targets },
      { id: "next", start_minute: 60, end_minute: 90, targets },
    ] }))
    expect(rule.periods.map(({ id, start_minute, end_minute }) => ({ id, start_minute, end_minute }))).toEqual([
      { id: "night", start_minute: 0, end_minute: 60 },
      { id: "next", start_minute: 60, end_minute: 90 },
      { id: "night", start_minute: 1380, end_minute: 1440 },
    ])
    db = fixture.reopen()
    expect(getRoutingRule(db, rule.id)?.periods).toEqual(rule.periods)
  })

  test("supports Monday-based UTC fragments from UTC+08 and UTC+05:45 editors", () => {
    const targets = ruleInput().default_chain
    const weekly = createRoutingRule(db, ruleInput({ mode: "weekly", periods: [
      { id: "monday-local", start_minute: 6 * 1440 + 960, end_minute: 6 * 1440 + 1080, targets },
      { id: "nepal", start_minute: 255, end_minute: 285, targets },
    ] }))
    expect(weekly.periods.map((period) => period.start_minute)).toEqual([255, 9600])
  })

  test("rejects an entire conflicting copy-day save, including overnight-created overlaps", () => {
    const targets = ruleInput().default_chain
    const input = ruleInput({ mode: "weekly", periods: [{ id: "original", start_minute: 30, end_minute: 90, targets }] })
    const existing = createRoutingRule(db, input)
    expect(() => updateRoutingRule(db, existing.id, { ...input, periods: [
      ...input.periods, { id: "copied-sunday", start_minute: 10020, end_minute: 60, targets },
    ] })).toThrow("overlap")
    expect(getRoutingRule(db, existing.id)).toEqual(existing)
  })

  test("upstream reference validation includes periods and runs before any persisted edit", () => {
    const existing = createRoutingRule(db, ruleInput())
    const missing = [{ upstream_id: "missing", model: "raw" }]
    expect(() => createRoutingRule(db, ruleInput({ default_chain: missing }))).toThrow("Unknown upstream")
    expect(() => updateRoutingRule(db, existing.id, ruleInput({ mode: "daily", periods: [{ id: "one", start_minute: 0, end_minute: 60, targets: missing }] }))).toThrow("Unknown upstream")
    expect(getRoutingRule(db, existing.id)).toEqual(existing)
    expect(listRoutingRules(db)).toHaveLength(2)
  })

  test.each([
    { name: "" }, { allow_conversion: "yes" }, { mode: "unknown" }, { default_chain: [] },
    { default_chain: [{ upstream_id: "builtin:copilot", model: "auto" }] },
    { default_chain: [{ upstream_id: "builtin:copilot", model: " " }] },
    { default_chain: [{ upstream_id: "", model: "raw" }] },
    { model_patterns: [] },
    { mode: "daily", periods: [{ id: "one", start_minute: 0, end_minute: 0, targets: ruleInput().default_chain }] },
    { mode: "daily", periods: [{ id: "one", start_minute: 0.5, end_minute: 60, targets: ruleInput().default_chain }] },
    { periods: [{ id: "one", start_minute: 0, end_minute: 60, targets: ruleInput().default_chain }] },
    { mode: "daily", periods: [{ id: "one", start_minute: 0, end_minute: 60, targets: [] }] },
    { mode: "daily", periods: [
      { id: "same", start_minute: 0, end_minute: 60, targets: ruleInput().default_chain },
      { id: "same", start_minute: 90, end_minute: 120, targets: [{ upstream_id: "builtin:copilot", model: "different" }] },
    ] },
  ])("rejects malformed rules: %j", (invalid) => {
    expect(() => createRoutingRule(db, { ...ruleInput(), ...invalid } as any)).toThrow(RoutingError)
    expect(listRoutingRules(db)).toHaveLength(1)
  })
})
