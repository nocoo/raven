import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initDatabase } from "../../src/db/requests"
import { initSettings, setSetting } from "../../src/db/settings"
import { RETENTION_SETTING } from "../../src/core/history-retention"
import { startHistoryRetention } from "../../src/services/history-retention"
import { logger } from "../../src/util/logger"

const NOW = Date.UTC(2026, 8, 23)
const DAY = 86_400_000
const HOUR = 3_600_000
let db: Database
let stop: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  vi.spyOn(logger, "info").mockImplementation(() => {})
  vi.spyOn(logger, "error").mockImplementation(() => {})
  db = new Database(":memory:"); initDatabase(db); initSettings(db)
})
afterEach(() => { stop?.(); stop = undefined; db.close(); vi.useRealTimers(); vi.restoreAllMocks() })

function insert(id: string, age: number) {
  db.query("INSERT INTO requests (id, timestamp, path, client_format, model, stream, latency_ms, status, status_code) VALUES (?, ?, '/v1/responses', 'responses', 'fixture', 0, 1, 'success', 200)").run(id, NOW - age * DAY)
}
function count() { return db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM requests").get()!.total }

describe("hourly history cleanup", () => {
  it("runs only the 90-day migration immediately and the configured policy hourly", () => {
    insert("expired-migration", 91); insert("expired-policy", 31); insert("recent", 1)
    stop = startHistoryRetention(db)
    expect(count()).toBe(2)
    vi.advanceTimersByTime(HOUR - 1)
    expect(count()).toBe(2)
    vi.advanceTimersByTime(1)
    expect(count()).toBe(1)
    expect(logger.info).toHaveBeenCalledWith("Expired request history deleted", { days: 30, deleted: 1 })
    vi.advanceTimersByTime(HOUR)
    expect(count()).toBe(1)
    expect(logger.info).toHaveBeenCalledTimes(2)
  })

  it("reads changed settings at the next cycle and stops on shutdown", () => {
    insert("older", 40); insert("newer", 10)
    stop = startHistoryRetention(db)
    setSetting(db, RETENTION_SETTING, "90")
    vi.advanceTimersByTime(HOUR)
    expect(count()).toBe(2)
    setSetting(db, RETENTION_SETTING, "7")
    expect(count()).toBe(2)
    vi.advanceTimersByTime(HOUR)
    expect(count()).toBe(0)
    stop()
    insert("after-stop", 50)
    vi.advanceTimersByTime(HOUR * 2)
    expect(count()).toBe(1)
  })

  it("does not delete on invalid configuration and recovers after correction", () => {
    insert("old", 31)
    stop = startHistoryRetention(db)
    setSetting(db, RETENTION_SETTING, "1")
    vi.advanceTimersByTime(HOUR)
    expect(count()).toBe(1)
    expect(logger.error).toHaveBeenCalledWith("History cleanup failed; will retry next hour", { error: expect.stringContaining("History retention must be") })
    setSetting(db, RETENTION_SETTING, "30")
    vi.advanceTimersByTime(HOUR)
    expect(count()).toBe(0)
  })

  it("keeps the service available on a failed migration and retries next hour", () => {
    insert("old", 91)
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON requests BEGIN SELECT RAISE(ABORT, 'fixture busy'); END")
    stop = startHistoryRetention(db)
    expect(count()).toBe(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
    db.exec("DROP TRIGGER fail_delete")
    vi.advanceTimersByTime(HOUR)
    expect(count()).toBe(0)
    expect(logger.info).toHaveBeenCalledWith("History retention migration completed", { days: 90, deleted: 1 })
  })
})
