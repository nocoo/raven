import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RETENTION_DAYS, RETENTION_SETTING, parseRetentionDays } from "../../src/core/history-retention"
import { getRetentionDays, migrateHistoryRetention, pruneRequestHistory } from "../../src/db/history-retention"
import { initDatabase } from "../../src/db/requests"
import { getSetting, setSetting } from "../../src/db/settings"
import { NOW, routingFixture } from "./routing-fixture"

const DAY = 86_400_000
let fixture: ReturnType<typeof routingFixture>
beforeEach(() => { fixture = routingFixture(); initDatabase(fixture.db) })
afterEach(() => fixture.close())

function insert(id: string, timestamp: number) {
  fixture.db.query("INSERT INTO requests (id, timestamp, path, client_format, model, stream, latency_ms, status, status_code) VALUES (?, ?, '/v1/responses', 'responses', 'fixture', 0, 1, 'success', 200)").run(id, timestamp)
}

function ids() {
  return fixture.db.query<{ id: string }, []>("SELECT id FROM requests ORDER BY id").all().map(row => row.id)
}

describe("request history retention", () => {
  it("defaults to 30 days without creating an override", () => {
    expect(getRetentionDays(fixture.db)).toBe(30)
    expect(getSetting(fixture.db, RETENTION_SETTING)).toBeNull()
  })

  it.each(RETENTION_DAYS)("retains the exact %i-day boundary and newer rows", days => {
    setSetting(fixture.db, RETENTION_SETTING, String(days))
    expect(getRetentionDays(fixture.db)).toBe(days)
    const cutoff = NOW - days * DAY
    insert("expired", cutoff - 1)
    insert("boundary", cutoff)
    insert("recent", NOW)
    insert("future", NOW + DAY)
    expect(pruneRequestHistory(fixture.db, getRetentionDays(fixture.db), NOW)).toBe(1)
    expect(ids()).toEqual(["boundary", "future", "recent"])
    expect(pruneRequestHistory(fixture.db, days, NOW)).toBe(0)
  })

  it.each(["", "0", "6", "8", "91", "365", "-7", "7.5", "NaN", "30days", " 30", "030"])("rejects invalid persisted retention without deleting history: %s", value => {
    insert("old", NOW - 100 * DAY)
    setSetting(fixture.db, RETENTION_SETTING, value)
    expect(() => parseRetentionDays(value)).toThrow("History retention must be")
    expect(() => getRetentionDays(fixture.db)).toThrow("History retention must be")
    expect(ids()).toEqual(["old"])
  })

  it("migrates only older-than-90-day rows once, durably across restart", () => {
    insert("expired", NOW - 90 * DAY - 1)
    insert("boundary", NOW - 90 * DAY)
    insert("older-than-default", NOW - 31 * DAY)
    setSetting(fixture.db, RETENTION_SETTING, "7")
    expect(migrateHistoryRetention(fixture.db, NOW)).toBe(1)
    expect(ids()).toEqual(["boundary", "older-than-default"])
    fixture.reopen()
    expect(migrateHistoryRetention(fixture.db, NOW + 200 * DAY)).toBeNull()
    expect(ids()).toEqual(["boundary", "older-than-default"])
    expect(getRetentionDays(fixture.db)).toBe(7)
  })

  it("rolls back deletion if recording the migration fails, then retries safely", () => {
    insert("expired", NOW - 100 * DAY)
    fixture.db.exec("CREATE TRIGGER fail_marker BEFORE INSERT ON settings WHEN NEW.key = 'migration:history-retention:90d' BEGIN SELECT RAISE(ABORT, 'fixture marker failure'); END")
    expect(() => migrateHistoryRetention(fixture.db, NOW)).toThrow("fixture marker failure")
    expect(ids()).toEqual(["expired"])
    expect(getSetting(fixture.db, "migration:history-retention:90d")).toBeNull()
    fixture.db.exec("DROP TRIGGER fail_marker")
    expect(migrateHistoryRetention(fixture.db, NOW)).toBe(1)
  })

  it("preserves configurations, keys, quota windows and settlements", () => {
    const db = fixture.db
    insert("expired", NOW - 100 * DAY)
    db.exec("INSERT INTO api_keys (id, name, key_hash, key_prefix, rule_id, created_at) VALUES ('fixture-key', 'Fixture', 'synthetic-hash', 'fixture', 'builtin:copilot', 1)")
    db.exec("INSERT INTO quota_windows (id, upstream_id, starts_at, ends_at) VALUES ('fixture-window', 'builtin:copilot', 1, 2)")
    db.exec("INSERT INTO quota_settlements (request_id, attempt_ordinal, upstream_id, window_id, captured_at, usage_present, usage_complete, multiplier, weighted_debit) VALUES ('expired', 0, 'builtin:copilot', 'fixture-window', 1, 1, 1, 1, 0)")
    setSetting(db, "fixture-setting", "kept")
    const tables = ["providers", "routing_rules", "api_keys", "quota_windows", "quota_settlements"]
    const before = tables.map(table => db.query(`SELECT * FROM ${table}`).all())
    migrateHistoryRetention(db, NOW)
    pruneRequestHistory(db, 7, NOW)
    expect(tables.map(table => db.query(`SELECT * FROM ${table}`).all())).toEqual(before)
    expect(getSetting(db, "fixture-setting")).toBe("kept")
    expect(ids()).toEqual([])
  })
})
