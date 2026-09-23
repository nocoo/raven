import type { Database } from "bun:sqlite"
import { DEFAULT_RETENTION_DAYS, parseRetentionDays, RETENTION_SETTING, type RetentionDays } from "../core/history-retention"
import { getSetting, setSetting } from "./settings"

const MIGRATION_KEY = "migration:history-retention:90d"

export function getRetentionDays(db: Database): RetentionDays {
  const value = getSetting(db, RETENTION_SETTING)
  return value === null ? DEFAULT_RETENTION_DAYS : parseRetentionDays(value)
}

export function pruneRequestHistory(db: Database, days: RetentionDays, now: number): number {
  const cutoff = now - days * 86_400_000
  return db.query("DELETE FROM requests WHERE timestamp < ?").run(cutoff).changes
}

export function migrateHistoryRetention(db: Database, now: number): number | null {
  return db.transaction(() => {
    if (getSetting(db, MIGRATION_KEY) !== null) return null
    const deleted = pruneRequestHistory(db, 90, now)
    setSetting(db, MIGRATION_KEY, String(now))
    return deleted
  })()
}
