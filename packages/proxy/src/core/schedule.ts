import { RoutingError, type ScheduleInterval, type ScheduleMode } from "./routing-types.ts"

export function scheduleMinute(mode: ScheduleMode, timestamp: number): number {
  if (!Number.isFinite(timestamp)) throw new RoutingError("Invalid schedule timestamp")
  const date = new Date(timestamp)
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return mode === "weekly" ? ((date.getUTCDay() + 6) % 7) * 1440 + minute : minute
}

export function normalizeIntervals<T extends ScheduleInterval>(mode: ScheduleMode, intervals: readonly T[]): T[] {
  if (!["all_day", "daily", "weekly"].includes(mode)) throw new RoutingError("Invalid schedule mode")
  if (mode === "all_day") {
    if (intervals.length) throw new RoutingError("All-day schedules cannot contain periods")
    return []
  }
  const cycle = mode === "weekly" ? 10080 : 1440
  const fragments = intervals.flatMap((interval) => {
    const { id, start_minute: start, end_minute: end } = interval
    if (!id.trim() || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || start >= cycle || end < 0 || end > cycle || start === end) {
      throw new RoutingError("Schedule ranges must be nonempty integer UTC minutes within their cycle")
    }
    if (start < end) return [{ ...interval }]
    const result = [{ ...interval, end_minute: cycle }]
    if (end > 0) result.push({ ...interval, start_minute: 0 })
    return result
  }).sort((a, b) => a.start_minute - b.start_minute)
  for (let index = 1; index < fragments.length; index++) {
    if (fragments[index]!.start_minute < fragments[index - 1]!.end_minute) {
      throw new RoutingError("Schedule periods overlap")
    }
  }
  return fragments
}

export function matchingInterval<T extends ScheduleInterval>(
  mode: ScheduleMode,
  intervals: readonly T[],
  timestamp: number,
): T | null {
  if (mode === "all_day") return null
  const minute = scheduleMinute(mode, timestamp)
  return intervals.find((interval) => interval.start_minute <= minute && minute < interval.end_minute) ?? null
}
