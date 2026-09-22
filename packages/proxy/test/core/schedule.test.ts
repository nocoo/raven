import { describe, expect, test } from "vitest"
import { matchingInterval, normalizeIntervals, scheduleMinute } from "../../src/core/schedule.ts"

const interval = (id: string, start_minute: number, end_minute: number) => ({ id, start_minute, end_minute })

describe("shared UTC interval evaluator", () => {
  test("uses UTC, Monday-based weeks and half-open boundaries", () => {
    const monday = Date.UTC(2026, 8, 21)
    const ranges = [interval("one", 0, 30), interval("two", 30, 60)]
    expect(scheduleMinute("weekly", monday)).toBe(0)
    expect(scheduleMinute("weekly", monday - 60000)).toBe(10079)
    expect(scheduleMinute("daily", monday + 255 * 60000)).toBe(255)
    expect(matchingInterval("daily", ranges, monday + 29 * 60000 + 59999)?.id).toBe("one")
    expect(matchingInterval("daily", ranges, monday + 30 * 60000)?.id).toBe("two")
    expect(matchingInterval("daily", ranges, monday + 60 * 60000)).toBeNull()
    expect(matchingInterval("all_day", ranges, monday)).toBeNull()
    expect(() => scheduleMinute("daily", Number.NaN)).toThrow()
    expect(() => scheduleMinute("weekly", Number.POSITIVE_INFINITY)).toThrow()
  })

  test("normalizes day/week rollover under stable IDs without changing input or merging neighbors", () => {
    const ranges = [interval("night", 1380, 60), interval("neighbor", 60, 90)]
    const snapshot = structuredClone(ranges)
    expect(normalizeIntervals("daily", ranges)).toEqual([
      interval("night", 0, 60), interval("neighbor", 60, 90), interval("night", 1380, 1440),
    ])
    expect(ranges).toEqual(snapshot)
    expect(normalizeIntervals("weekly", [interval("week-end", 10020, 30)])).toEqual([interval("week-end", 0, 30), interval("week-end", 10020, 10080)])
    expect(normalizeIntervals("daily", [interval("midnight", 1200, 0)])).toEqual([interval("midnight", 1200, 1440)])
    expect(normalizeIntervals("all_day", [])).toEqual([])
  })

  test.each([
    ["daily", [interval("zero", 0, 0)]], ["daily", [interval("negative", -1, 20)]],
    ["daily", [interval("outside", 1440, 1441)]], ["daily", [interval("end", 0, 1441)]],
    ["daily", [interval("fraction", 0, 1.5)]], ["daily", [interval(" ", 0, 60)]],
    ["daily", [interval("overlap", 1380, 60), interval("other", 30, 90)]],
    ["weekly", [interval("one", 10050, 60), interval("two", 0, 90)]],
    ["all_day", [interval("not-allowed", 0, 1440)]], ["unknown", []],
  ])("rejects invalid normalized schedule %j %j", (mode, ranges) => {
    expect(() => normalizeIntervals(mode as any, ranges as any)).toThrow()
  })
})
