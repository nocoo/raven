import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_RULE_ID } from "../../src/core/routing-types.ts"
import { createApiKey } from "../../src/db/keys.ts"
import { createRoutingRule, getRoutingRule } from "../../src/db/routing-rules.ts"
import { createRoutingRulesRoute } from "../../src/routes/routing-rules.ts"
import { NOW, routingFixture, ruleInput } from "../db/routing-fixture.ts"

let fixture: ReturnType<typeof routingFixture>
let db: Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  db = fixture.db
})
afterEach(() => { fixture.close(); vi.useRealTimers() })

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

describe("routing rule management routes", () => {
  test("lists, creates, retrieves, updates and deletes entities with conversion opt-in", async () => {
    const app = createRoutingRulesRoute(db)
    const initial = await (await app.request("/routing-rules")).json()
    expect(initial).toHaveLength(1)
    expect(initial[0]).toMatchObject({ id: COPILOT_RULE_ID, is_builtin: true, allow_conversion: true })
    const response = await app.request("/routing-rules", json("POST", ruleInput()))
    expect(response.status).toBe(201)
    const rule = await response.json()
    expect(rule).toMatchObject({ name: "Fixture rule", allow_conversion: false, is_builtin: false })
    expect(await (await app.request(`/routing-rules/${rule.id}`)).json()).toEqual(rule)
    const changed = await app.request(`/routing-rules/${rule.id}`, json("PUT", ruleInput({ allow_conversion: true, name: "Edited" })))
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ id: rule.id, name: "Edited", allow_conversion: true })
    const deleted = await app.request(`/routing-rules/${rule.id}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ success: true })
    expect(getRoutingRule(db, rule.id)).toBeNull()
  })

  test("protects the builtin and returns safe referencing keys without silently rebinding", async () => {
    const app = createRoutingRulesRoute(db)
    const rule = createRoutingRule(db, ruleInput())
    const key = createApiKey(db, "Bound", rule.id)
    const response = await app.request(`/routing-rules/${rule.id}`, { method: "DELETE" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: { type: "reference_conflict", message: "Routing rule is referenced by client keys", references: [{ kind: "key", id: key.id, name: "Bound" }] } })
    expect(getRoutingRule(db, rule.id)).not.toBeNull()
    const builtin = await app.request(`/routing-rules/${COPILOT_RULE_ID}`, { method: "DELETE" })
    expect(builtin.status).toBe(409)
    expect((await builtin.json()).error.references).toEqual([{ kind: "builtin", id: "env:default", name: "Environment client key" }])
  })

  test("unknown entities return 404 on GET, PUT and DELETE", async () => {
    const app = createRoutingRulesRoute(db)
    for (const request of [undefined, json("PUT", ruleInput()), { method: "DELETE" }]) {
      const response = await app.request("/routing-rules/missing", request)
      expect(response.status).toBe(404)
      expect((await response.json()).error.type).toBe("not_found")
    }
  })

  test.each([
    null, [], {}, { ...ruleInput(), default_chain: [] },
    { ...ruleInput(), default_chain: [{ upstream_id: "missing", model: "typed" }] },
    { ...ruleInput(), default_chain: [{ upstream_id: "builtin:copilot", model: "auto" }] },
    { ...ruleInput(), allow_conversion: "true" },
  ])("invalid requests return validation errors: %j", async (payload) => {
    const response = await createRoutingRulesRoute(db).request("/routing-rules", json("POST", payload))
    expect(response.status).toBe(400)
    expect((await response.json()).error.type).toBe("validation_error")
  })

  test("rejects overlapping timetable edits atomically while preserving logical fragment IDs", async () => {
    const app = createRoutingRulesRoute(db)
    const targets = ruleInput().default_chain
    const input = ruleInput({ mode: "weekly", periods: [
      { id: "overnight", start_minute: 10020, end_minute: 10080, targets },
      { id: "overnight", start_minute: 0, end_minute: 60, targets },
    ] })
    const created = await (await app.request("/routing-rules", json("POST", input))).json()
    expect(created.periods.map((period: { id: string }) => period.id)).toEqual(["overnight", "overnight"])
    const response = await app.request(`/routing-rules/${created.id}`, json("PUT", { ...input, periods: [...input.periods, { id: "copied", start_minute: 30, end_minute: 90, targets }] }))
    expect(response.status).toBe(400)
    expect(getRoutingRule(db, created.id)).toEqual(created)
  })

  test("malformed JSON and storage errors preserve management error shape", async () => {
    const app = createRoutingRulesRoute(db)
    expect((await app.request("/routing-rules", { method: "POST", body: "{" })).status).toBe(400)
    db.close()
    const response = await app.request("/routing-rules")
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { type: "internal_error", message: "Routing rule operation failed" } })
  })
})
