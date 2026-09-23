export const RETENTION_DAYS = [7, 14, 30, 60, 90] as const
export type RetentionDays = typeof RETENTION_DAYS[number]
export const DEFAULT_RETENTION_DAYS: RetentionDays = 30
export const RETENTION_SETTING = "history_retention_days"

export function parseRetentionDays(value: string): RetentionDays {
  const days = RETENTION_DAYS.find(days => String(days) === value)
  if (days === undefined) throw new Error("History retention must be 7, 14, 30, 60 or 90 days")
  return days
}
