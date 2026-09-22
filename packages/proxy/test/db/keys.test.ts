import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_RULE_ID } from "../../src/core/routing-types.ts"
import { createApiKey, deleteApiKey, initApiKeys, listApiKeys, revokeApiKey, updateApiKeyRule, validateApiKey } from "../../src/db/keys.ts"
import { createRoutingRule, deleteRoutingRule } from "../../src/db/routing-rules.ts"
import { NOW, routingFixture, ruleInput } from "./routing-fixture.ts"

let fixture: ReturnType<typeof routingFixture>
let db: Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  db = fixture.db
})
afterEach(() => { fixture.close(); vi.useRealTimers() })

describe("bound API keys", () => {
  test("creates unique one-time credentials with explicit bindings and private hashes", () => {
    initApiKeys(db)
    expect(listApiKeys(db)).toEqual([])
    const first = createApiKey(db, " first ", COPILOT_RULE_ID)
    const second = createApiKey(db, "Second", COPILOT_RULE_ID)
    expect(first.key).toMatch(/^rk-[a-f0-9]{64}$/)
    expect(first.key_prefix).toBe(first.key.slice(0, 12))
    expect(first.id).not.toBe(second.id)
    expect(first.key).not.toBe(second.key)
    expect(first).toMatchObject({ name: "first", rule_id: COPILOT_RULE_ID, created_at: NOW, last_used_at: null, revoked_at: null })
    for (const key of listApiKeys(db)) {
      expect(key).not.toHaveProperty("key_hash")
      expect(key).not.toHaveProperty("key")
    }
    expect(db.query("SELECT key_hash FROM api_keys WHERE id = ?").get(first.id)).toEqual({ key_hash: new Bun.CryptoHasher("sha256").update(first.key).digest("hex") })
  })

  test("validates, records use, and preserves identity through rebind/reopen", () => {
    const rule = createRoutingRule(db, ruleInput())
    const first = createApiKey(db, "First", COPILOT_RULE_ID)
    const second = createApiKey(db, "Second", COPILOT_RULE_ID)
    const snapshot = validateApiKey(db, first.key)!
    vi.setSystemTime(NOW + 100)
    const changed = updateApiKeyRule(db, first.id, rule.id)
    expect(changed).toMatchObject({ id: first.id, key_prefix: first.key_prefix, created_at: NOW, last_used_at: NOW, rule_id: rule.id })
    expect(changed).not.toHaveProperty("key")
    expect(changed).not.toHaveProperty("key_hash")
    expect(snapshot.rule_id).toBe(COPILOT_RULE_ID)
    db = fixture.reopen()
    expect(validateApiKey(db, first.key)?.rule_id).toBe(rule.id)
    expect(validateApiKey(db, second.key)?.rule_id).toBe(COPILOT_RULE_ID)
    expect(listApiKeys(db).find((key) => key.id === first.id)?.last_used_at).toBe(NOW + 100)
  })

  test("invalid/revoked keys stay invalid and rule references remain protected", () => {
    const rule = createRoutingRule(db, ruleInput())
    const key = createApiKey(db, "Revoked", rule.id)
    expect(validateApiKey(db, "unknown-fixture")).toBeNull()
    expect(revokeApiKey(db, key.id)).toBe(true)
    expect(revokeApiKey(db, key.id)).toBe(false)
    expect(revokeApiKey(db, "missing")).toBe(false)
    expect(validateApiKey(db, key.key)).toBeNull()
    expect(() => deleteRoutingRule(db, rule.id)).toThrow("referenced")
    expect(updateApiKeyRule(db, key.id, COPILOT_RULE_ID)?.revoked_at).toBe(NOW)
    expect(validateApiKey(db, key.key)).toBeNull()
    expect(deleteRoutingRule(db, rule.id)).toBe(true)
    expect(deleteApiKey(db, key.id)).toBe(true)
    expect(deleteApiKey(db, key.id)).toBe(false)
    expect(listApiKeys(db)).toEqual([])
  })

  test("two keys may share a rule and conflict references contain only safe key identity", () => {
    const rule = createRoutingRule(db, ruleInput())
    const keys = [createApiKey(db, "One", rule.id), createApiKey(db, "Two", rule.id)]
    try { deleteRoutingRule(db, rule.id); throw new Error("Expected conflict") } catch (error) {
      expect(error).toMatchObject({ status: 409, references: expect.arrayContaining(keys.map(({ id, name }) => ({ kind: "key", id, name }))) })
      expect(JSON.stringify(error)).not.toContain(keys[0]!.key)
    }
  })

  test("rejects null, absent and unknown bindings in application and SQLite", () => {
    for (const rule of [null, undefined, "", "missing"]) expect(() => createApiKey(db, "Fixture", rule as any)).toThrow()
    for (const name of ["", " ", "x".repeat(65)]) expect(() => createApiKey(db, name, COPILOT_RULE_ID)).toThrow()
    const key = createApiKey(db, "Valid", COPILOT_RULE_ID)
    expect(() => updateApiKeyRule(db, key.id, "missing")).toThrow("does not exist")
    expect(() => updateApiKeyRule(db, key.id, null as any)).toThrow()
    expect(updateApiKeyRule(db, "missing", COPILOT_RULE_ID)).toBeNull()
    expect(() => db.query("UPDATE api_keys SET rule_id = NULL WHERE id = ?").run(key.id)).toThrow("NOT NULL")
    expect(() => db.query("UPDATE api_keys SET rule_id = 'missing' WHERE id = ?").run(key.id)).toThrow("FOREIGN KEY")
    expect(validateApiKey(db, key.key)?.rule_id).toBe(COPILOT_RULE_ID)
  })
})
