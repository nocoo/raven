import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../../src/core/routing-types.ts"
import { createApiKey, updateApiKeyRule, validateApiKey } from "../../src/db/keys.ts"
import { getProvider, getProviderRecord, listProviders } from "../../src/db/providers.ts"
import { getRoutingMigrationSummary, initRouting, ROUTING_SCHEMA_VERSION } from "../../src/db/routing-migration.ts"
import { createRoutingRule, getRoutingRule, updateRoutingRule } from "../../src/db/routing-rules.ts"
import { getSetting } from "../../src/db/settings.ts"
import { NOW, routingFixture, ruleInput } from "./routing-fixture.ts"

let fixture: ReturnType<typeof routingFixture>
let db: Database
const rawKey = `rk-${"a".repeat(64)}`

function legacy() {
  db.exec(`CREATE TABLE providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, format TEXT NOT NULL,
    api_key TEXT NOT NULL, model_patterns TEXT NOT NULL, enabled INTEGER NOT NULL,
    supports_reasoning INTEGER, supports_models_endpoint INTEGER, auth_style TEXT, use_socks5 INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
    CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
    CREATE TABLE requests (id TEXT PRIMARY KEY, model TEXT NOT NULL);
    INSERT INTO requests VALUES ('history', 'old-model');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('existing', 'preserve');`)
  db.query("INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "custom-legacy", "Legacy", "https://fixture.invalid", "openai", "fixture-only-secret",
    JSON.stringify(["raw/model", "wild-*", "raw/model", "auto"]), 0, 1, 0, "bearer", 1, 1, 2,
  )
  db.query("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?)").run("existing-key", "Existing", new Bun.CryptoHasher("sha256").update(rawKey).digest("hex"), rawKey.slice(0, 12), 1, 2, null)
  db.query("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?)").run("revoked-key", "Revoked", "fixture-revoked-hash", "rk-revoked", 1, 2, 3)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture(false)
  db = fixture.db
})
afterEach(() => { fixture.close(); vi.useRealTimers() })

describe("transactional R3 migration", () => {
  test("initializes protected defaults and real foreign keys on a fresh database", () => {
    initRouting(db)
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: ROUTING_SCHEMA_VERSION })
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(getRoutingMigrationSummary(db)).toBeNull()
    expect(listProviders(db)).toHaveLength(1)
    expect(getProvider(db, COPILOT_UPSTREAM_ID)).toMatchObject({ kind: "copilot", format: null, is_enabled: true, quota: null, models: [] })
    expect(getRoutingRule(db, COPILOT_RULE_ID)).toMatchObject({ allow_conversion: true, default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }] })
    expect(() => db.query("DELETE FROM providers WHERE id = ?").run(COPILOT_UPSTREAM_ID)).toThrow("protected")
    expect(() => db.query("UPDATE providers SET enabled = 0 WHERE id = ?").run(COPILOT_UPSTREAM_ID)).toThrow()
    expect(() => db.query("UPDATE providers SET id = 'changed' WHERE id = ?").run(COPILOT_UPSTREAM_ID)).toThrow("protected")
    expect(() => db.query("DELETE FROM routing_rules WHERE id = ?").run(COPILOT_RULE_ID)).toThrow("protected")
    expect(() => db.query("UPDATE routing_rules SET is_builtin = 0 WHERE id = ?").run(COPILOT_RULE_ID)).toThrow("protected")
  })

  test("preserves credentials, identities, revocation, options and history; saves a safe report", () => {
    legacy()
    const before = db.query("SELECT * FROM api_keys ORDER BY id").all() as Record<string, unknown>[]
    initRouting(db)
    expect(db.query("SELECT * FROM api_keys ORDER BY id").all()).toEqual(before.map((row) => ({ ...row, rule_id: COPILOT_RULE_ID })))
    expect(validateApiKey(db, rawKey)).toMatchObject({ id: "existing-key", rule_id: COPILOT_RULE_ID })
    expect(getProviderRecord(db, "custom-legacy")).toMatchObject({
      api_key: "fixture-only-secret", format: "chat_completions", auth_style: "bearer", use_socks5: true,
      supports_reasoning: true, is_enabled: false, manual_models: ["raw/model", "auto"], created_at: 1, updated_at: 2,
    })
    expect(getSetting(db, "existing")).toBe("preserve")
    expect(db.query("SELECT * FROM requests").all()).toEqual([{ id: "history", model: "old-model" }])
    expect((db.query("PRAGMA table_info(providers)").all() as { name: string }[]).map((row) => row.name)).not.toContain("model_patterns")
    const summary = getRoutingMigrationSummary(db)
    expect(summary).toEqual({ migrated_at: NOW, upstreams: [{ id: "custom-legacy", name: "Legacy", retained_models: ["raw/model", "auto"], discarded_patterns: ["wild-*"] }], keys: [
      { id: "existing-key", name: "Existing", rule_id: COPILOT_RULE_ID }, { id: "revoked-key", name: "Revoked", rule_id: COPILOT_RULE_ID },
    ] })
    expect(JSON.stringify(summary)).not.toContain("fixture-only-secret")
    expect(JSON.stringify(summary)).not.toContain("hash")
  })

  test("reopen enables FK enforcement and never resets edited defaults, bindings or report", () => {
    legacy()
    initRouting(db)
    const summary = getRoutingMigrationSummary(db)
    const rule = createRoutingRule(db, ruleInput())
    updateApiKeyRule(db, "existing-key", rule.id)
    updateRoutingRule(db, COPILOT_RULE_ID, ruleInput({ default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "edited" }] }))
    db = fixture.reopen()
    initRouting(db)
    expect(validateApiKey(db, rawKey)?.rule_id).toBe(rule.id)
    expect(getRoutingRule(db, COPILOT_RULE_ID)).toMatchObject({ allow_conversion: true, default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "edited" }] })
    expect(getRoutingMigrationSummary(db)).toEqual(summary)
    expect(() => db.query("UPDATE api_keys SET rule_id = NULL WHERE id = 'existing-key'").run()).toThrow("NOT NULL")
    expect(() => db.query("UPDATE api_keys SET rule_id = 'missing' WHERE id = 'existing-key'").run()).toThrow("FOREIGN KEY")
    expect(() => db.query("DELETE FROM routing_rules WHERE id = ?").run(rule.id)).toThrow("FOREIGN KEY")
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    const connection = new Database(fixture.path)
    try {
      initRouting(connection)
      expect(connection.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
      expect(() => connection.query("UPDATE api_keys SET rule_id = 'missing' WHERE id = 'existing-key'").run()).toThrow()
    } finally { connection.close() }
  })

  test("a late migration failure rolls back tables, data, summary and checkpoint together", () => {
    legacy()
    db.exec("CREATE TRIGGER reject_report BEFORE INSERT ON settings WHEN NEW.key = 'routing:r3:migration' BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END")
    expect(() => initRouting(db)).toThrow("forced migration failure")
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 })
    expect(db.query("SELECT model_patterns FROM providers").get()).toEqual({ model_patterns: JSON.stringify(["raw/model", "wild-*", "raw/model", "auto"]) })
    expect((db.query("PRAGMA table_info(api_keys)").all() as { name: string }[]).some((row) => row.name === "rule_id")).toBe(false)
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '%legacy_r3' OR name = 'routing_rules'").all()).toEqual([])
    expect(getRoutingMigrationSummary(db)).toBeNull()
    db.exec("DROP TRIGGER reject_report")
    initRouting(db)
    expect(validateApiKey(db, rawKey)?.id).toBe("existing-key")
  })

  test.each(["broken-json", "null", '["valid",null,3,"", "a*"]'])("handles malformed legacy patterns without inventing routing (%s)", (patterns) => {
    db.exec("CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, format TEXT, api_key TEXT, model_patterns TEXT, enabled INTEGER, created_at INTEGER, updated_at INTEGER)")
    db.query("INSERT INTO providers VALUES ('old', 'Old', 'https://fixture.invalid', 'anthropic', 'fixture', ?, 1, 1, 1)").run(patterns)
    initRouting(db)
    expect(getProviderRecord(db, "old")).toMatchObject({ format: "anthropic_messages", auth_style: null, use_socks5: null, supports_reasoning: false })
    expect(getProviderRecord(db, "old")?.manual_models).toEqual(patterns.startsWith("[") ? ["valid"] : [])
    expect(db.query("SELECT COUNT(*) AS count FROM routing_rules").get()).toEqual({ count: 1 })
  })

  test("rejects invalid legacy formats atomically, future versions, and unenforced connection FKs", () => {
    legacy()
    db.query("UPDATE providers SET format = 'unknown'").run()
    expect(() => initRouting(db)).toThrow()
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 })
    db.exec("PRAGMA user_version = 999")
    expect(() => initRouting(db)).toThrow("Unsupported routing schema version")
    db.exec("PRAGMA user_version = 0; PRAGMA foreign_keys = OFF")
    expect(() => db.transaction(() => initRouting(db))()).toThrow("requires foreign keys")
  })

  test("current-version startup rejects preexisting dangling keys instead of repairing them", () => {
    initRouting(db)
    const key = createApiKey(db, "Fixture", COPILOT_RULE_ID)
    db.exec("PRAGMA foreign_keys = OFF")
    db.query("UPDATE api_keys SET rule_id = 'dangling' WHERE id = ?").run(key.id)
    expect(() => initRouting(db)).toThrow("invalid foreign keys")
    expect(db.query("SELECT rule_id FROM api_keys WHERE id = ?").get(key.id)).toEqual({ rule_id: "dangling" })
  })
})
