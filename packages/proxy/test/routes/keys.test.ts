import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_RULE_ID } from "../../src/core/routing-types.ts"
import { createApiKey, listApiKeys, validateApiKey } from "../../src/db/keys.ts"
import { createRoutingRule } from "../../src/db/routing-rules.ts"
import { createKeysRoute } from "../../src/routes/keys.ts"
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

describe("key management with mandatory rule bindings", () => {
  test("creates an explicitly bound key and exposes its raw secret only once", async () => {
    const app = createKeysRoute(db)
    expect(await (await app.request("/keys")).json()).toEqual([])
    const response = await app.request("/keys", json("POST", { name: "Key", rule_id: COPILOT_RULE_ID }))
    expect(response.status).toBe(201)
    const key = await response.json()
    expect(key).toMatchObject({ name: "Key", rule_id: COPILOT_RULE_ID, key: expect.stringMatching(/^rk-[a-f0-9]{64}$/) })
    expect(key).not.toHaveProperty("key_hash")
    const list = await (await app.request("/keys")).json()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: key.id, rule_id: COPILOT_RULE_ID })
    expect(list[0]).not.toHaveProperty("key")
    expect(list[0]).not.toHaveProperty("key_hash")
    expect(validateApiKey(db, key.key)?.id).toBe(key.id)
  })

  test("PATCH changes only the selected key binding without rotating the key or editing another key", async () => {
    const first = createApiKey(db, "First", COPILOT_RULE_ID)
    const second = createApiKey(db, "Second", COPILOT_RULE_ID)
    const rule = createRoutingRule(db, ruleInput())
    const app = createKeysRoute(db)
    const response = await app.request(`/keys/${first.id}`, json("PATCH", { rule_id: rule.id }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: first.id, name: "First", key_prefix: first.key_prefix, rule_id: rule.id, created_at: first.created_at })
    expect(validateApiKey(db, first.key)?.rule_id).toBe(rule.id)
    expect(validateApiKey(db, second.key)?.rule_id).toBe(COPILOT_RULE_ID)
    expect(JSON.stringify(await (await app.request("/keys")).json())).not.toContain(first.key)
    expect((await app.request("/keys/missing", json("PATCH", { rule_id: rule.id }))).status).toBe(404)
  })

  test.each([
    {}, null, [], { name: "" }, { name: "x".repeat(65), rule_id: COPILOT_RULE_ID },
    { name: "Name" }, { name: "Name", rule_id: null }, { name: "Name", rule_id: "missing" },
    { name: "Name", rule_id: COPILOT_RULE_ID, unknown: true },
  ])("POST rejects invalid payload and never inserts an unbound key: %j", async (payload) => {
    const response = await createKeysRoute(db).request("/keys", json("POST", payload))
    expect(response.status).toBe(400)
    expect((await response.json()).error.type).toBe("validation_error")
    expect(listApiKeys(db)).toHaveLength(0)
  })

  test.each([{}, { rule_id: null }, { rule_id: "missing" }, { rule_id: COPILOT_RULE_ID, name: "Unrequested rename" }])("PATCH validates the binding atomically: %j", async (payload) => {
    const key = createApiKey(db, "Original", COPILOT_RULE_ID)
    const response = await createKeysRoute(db).request(`/keys/${key.id}`, json("PATCH", payload))
    expect(response.status).toBe(400)
    expect(validateApiKey(db, key.key)).toMatchObject({ rule_id: COPILOT_RULE_ID, name: "Original" })
  })

  test("revocation and deletion keep their lifecycle behavior and exact not-found errors", async () => {
    const key = createApiKey(db, "Lifecycle", COPILOT_RULE_ID)
    const app = createKeysRoute(db)
    const revoked = await app.request(`/keys/${key.id}/revoke`, { method: "POST" })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ ok: true })
    expect(validateApiKey(db, key.key)).toBeNull()
    expect((await app.request(`/keys/${key.id}/revoke`, { method: "POST" })).status).toBe(404)
    expect((await app.request("/keys/missing/revoke", { method: "POST" })).status).toBe(404)
    const deleted = await app.request(`/keys/${key.id}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ success: true })
    expect(listApiKeys(db)).toEqual([])
    expect((await app.request(`/keys/${key.id}`, { method: "DELETE" })).status).toBe(404)
  })

  test("malformed JSON is a validation error; failed storage stays a sanitized server error", async () => {
    const app = createKeysRoute(db)
    const malformed = await app.request("/keys", { method: "POST", body: "{" })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { type: "validation_error" } })
    db.close()
    const storage = await app.request("/keys")
    expect(storage.status).toBe(500)
    expect(await storage.json()).toEqual({ error: { type: "internal_error", message: "Key operation failed" } })
  })
})
