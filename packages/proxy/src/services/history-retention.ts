import type { Database } from "bun:sqlite"
import { getRetentionDays, migrateHistoryRetention, pruneRequestHistory } from "../db/history-retention"
import { logger } from "../util/logger"

export function startHistoryRetention(db: Database): () => void {
  const clean = (scheduled: boolean) => {
    try {
      const now = Date.now()
      const migrated = migrateHistoryRetention(db, now)
      if (migrated !== null) logger.info("History retention migration completed", { days: 90, deleted: migrated })
      if (scheduled) {
        const days = getRetentionDays(db)
        const deleted = pruneRequestHistory(db, days, now)
        if (deleted > 0) logger.info("Expired request history deleted", { days, deleted })
      }
    } catch (error) {
      logger.error("History cleanup failed; will retry next hour", { error: String(error) })
    }
  }
  clean(false)
  const timer = setInterval(() => clean(true), 3_600_000)
  timer.unref()
  return () => clearInterval(timer)
}
