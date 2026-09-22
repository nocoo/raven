import { describe, expect, it } from "vitest";
import { availableWindow, changeScheduleMode, copyDay, DAY, daySegments, localDateTime, minuteLabel, offsetLabel, setWindowEnd, toLocalWindows, toUtcWindows, utcDateTime, utcWindowLabel, WEEK, wrap, type LocalWindow } from "@/lib/routing-schedule";

const window = (overrides: Partial<LocalWindow<string[]>> = {}): LocalWindow<string[]> => ({ id: "focus", day: 0, start: 540, end: 1020, value: ["primary", "terminal"], ...overrides });

function idFactory() { let id = 0; return () => `copy-${++id}`; }

describe("local schedules persisted as fixed UTC recurrences", () => {
  it("places Monday early morning in the previous UTC week at UTC+08", () => {
    const result = toUtcWindows([window({ start: 0, end: 120 })], "weekly", -480);
    expect(result).toEqual([{ id: "focus", start_minute: 9600, end_minute: 9720, value: ["primary", "terminal"] }]);
    expect(toLocalWindows(result, "weekly", -480)).toEqual([window({ start: 0, end: 120 })]);
  });

  it("does not round UTC minutes in UTC+05:45", () => {
    const local = [window({ start: 360, end: 450 })];
    const utc = toUtcWindows(local, "daily", -345);
    expect(utc[0]).toMatchObject({ start_minute: 15, end_minute: 105 });
    expect(toLocalWindows(utc, "daily", -345)).toEqual(local);
  });

  it("splits Sunday overnight and rejoins only by logical identity", () => {
    const local = [window({ day: 6, start: 1410, end: 1530 }), window({ id: "adjacent", day: 0, start: 90, end: 120 })];
    const utc = toUtcWindows(local, "weekly", 0);
    expect(utc.map(item => [item.id, item.start_minute, item.end_minute])).toEqual([["focus", 0, 90], ["adjacent", 90, 120], ["focus", 10050, WEEK]]);
    expect(toLocalWindows(utc, "weekly", 0)).toEqual([local[1], local[0]]);
  });

  it("splits a daily overnight period and keeps half-open adjacent periods distinct", () => {
    const local = [window({ start: 1380, end: 1500 }), window({ id: "next", start: 60, end: 120 })];
    expect(toLocalWindows(toUtcWindows(local, "daily", 0), "daily", 0)).toEqual([local[1], local[0]]);
  });

  it.each([-840, -480, -345, 0, 210, 360, 720])("round trips local half-hour periods at offset %i", offset => {
    for (let day = 0; day < 7; day++) {
      for (const start of [0, 30, 540, 1380]) {
        for (const duration of [30, 90, 210]) {
          const local = [window({ day, start, end: start + duration })];
          const utc = toUtcWindows(local, "weekly", offset);
          expect(toLocalWindows(utc, "weekly", offset)).toEqual(local);
          expect(utc.every(fragment => fragment.start_minute >= 0 && fragment.end_minute <= WEEK)).toBe(true);
          expect(utc.reduce((sum, fragment) => sum + fragment.end_minute - fragment.start_minute, 0)).toBe(duration);
        }
      }
    }
  });

  it("changes display with offset changes without moving persisted UTC periods", () => {
    const saved = [{ id: "fixed", start_minute: 480, end_minute: 600, value: [] }];
    expect(toLocalWindows(saved, "weekly", 300)[0]).toMatchObject({ day: 0, start: 180, end: 300 });
    expect(toLocalWindows(saved, "weekly", 240)[0]).toMatchObject({ day: 0, start: 240, end: 360 });
    expect(saved[0]?.start_minute).toBe(480);
  });

  it("uses the default for all-day mode and empty scheduled days", () => {
    expect(toUtcWindows([window()], "all_day", 0)).toEqual([]);
    expect(toLocalWindows([{ id: "ignored", start_minute: 0, end_minute: 10, value: [] }], "all_day", 0)).toEqual([]);
    expect(toLocalWindows([], "weekly", 0)).toEqual([]);
  });

  it("handles a single midnight-to-midnight daily fragment", () => {
    expect(toLocalWindows([{ id: "whole", start_minute: 0, end_minute: DAY, value: 1 }], "daily", 0)).toEqual([{ id: "whole", day: 0, start: 0, end: DAY, value: 1 }]);
  });

  it("canonicalizes a full daily recurrence regardless of timezone offset", () => {
    const fullDay = window({ start: 0, end: DAY });
    expect(toLocalWindows(toUtcWindows([fullDay], "daily", -345), "daily", -345)).toEqual([fullDay]);
  });

  it.each([
    { start: 30, end: 30 }, { start: -1 }, { start: DAY }, { start: 0, end: DAY + 1 },
    { day: 7 }, { day: -1 }, { day: 0.5 }, { start: 30.5 },
  ])("rejects an invalid local range %j", invalid => {
    expect(() => toUtcWindows([window(invalid)], "weekly", 0)).toThrow("nonempty period");
  });

  it("rejects missing or duplicate logical ids and a weekday in daily mode", () => {
    expect(() => toUtcWindows([window({ id: "" })], "daily", 0)).toThrow("unique identity");
    expect(() => toUtcWindows([window(), window()], "daily", 0)).toThrow("unique identity");
    expect(() => toUtcWindows([window({ day: 1 })], "daily", 0)).toThrow("nonempty period");
  });

  it("rejects overnight overlap after UTC normalization", () => {
    expect(() => toUtcWindows([window({ day: 6, start: 1380, end: 1530 }), window({ id: "monday", start: 30, end: 90 })], "weekly", -345)).toThrow("overlap");
  });
});

describe("copying local start-day periods", () => {
  it("replaces destination start-day periods under fresh ids and clones chains", () => {
    const source = window({ start: 1320, end: 1500 });
    const original = [source, window({ id: "old-tuesday", day: 1 }), window({ id: "unrelated", day: 4 })];
    const next = copyDay(original, 0, [0, 1, 2, 2], -480, idFactory());
    expect(next.map(item => item.id)).toEqual(["focus", "unrelated", "copy-1", "copy-2"]);
    expect(next[2]).toMatchObject({ day: 1, start: 1320, end: 1500 });
    next[2]!.value.push("other");
    expect(source.value).toEqual(["primary", "terminal"]);
    expect(next[3]!.value).toEqual(["primary", "terminal"]);
    expect(original).toHaveLength(3);
  });

  it("rejects the whole copy when a prior-day tail overlaps the copied start", () => {
    const original = [window({ start: 30, end: 120 }), window({ id: "monday-late", start: 1380, end: 1530 })];
    const before = structuredClone(original);
    expect(() => copyDay(original, 0, [1, 3], 0, idFactory())).toThrow("overlap");
    expect(original).toEqual(before);
  });

  it("copies an empty source day by clearing only destination starts", () => {
    const original = [window({ day: 1 }), window({ id: "tail", day: 6, start: 1380, end: 1500 })];
    expect(copyDay(original, 0, [1], 0, idFactory())).toEqual([original[1]]);
  });

  it("builds weekday mode from daily recurrence and keeps selected-day periods when switching back", () => {
    const original = [window()];
    const week = changeScheduleMode(original, "daily", "weekly", 0, idFactory());
    expect(week).toHaveLength(7);
    expect(new Set(week.map(item => item.id)).size).toBe(7);
    expect(changeScheduleMode(week, "weekly", "daily", 4, idFactory())).toEqual([{ ...week[4], day: 0 }]);
    expect(changeScheduleMode(original, "daily", "daily", 0, idFactory())).toBe(original);
    expect(changeScheduleMode(original, "daily", "all_day", 0, idFactory())).toEqual([]);
    expect(changeScheduleMode(original, "all_day", "weekly", 0, idFactory())).toEqual([]);
  });
});

describe("visual schedule and date helpers", () => {
  it("shows overnight tails on the following day while retaining their start day", () => {
    const windows = [window({ day: 6, start: 1320, end: 1500 })];
    expect(daySegments(windows, 6, "weekly")).toEqual([{ ...windows[0], end: DAY, tail: false }]);
    expect(daySegments(windows, 0, "weekly")).toEqual([{ ...windows[0], start: 0, end: 60, tail: true }]);
    expect(daySegments(windows, 2, "weekly")).toEqual([]);
    expect(daySegments([window({ start: 1320, end: 1500 })], 0, "daily")).toHaveLength(2);
  });

  it("finds free half-hour slots and reports a full day", () => {
    expect(availableWindow([], 0, "daily")).toEqual({ start: 540, end: 600 });
    expect(availableWindow([window()], 0, "daily")).toEqual({ start: 0, end: 60 });
    expect(availableWindow([window({ start: 30, end: DAY })], 0, "daily")).toEqual({ start: 0, end: 30 });
    expect(availableWindow([window({ start: 0, end: DAY })], 0, "daily")).toBeNull();
  });

  it("formats offsets and local/UTC previews, including midnight", () => {
    expect(offsetLabel(-345)).toBe("UTC+05:45");
    expect(offsetLabel(210)).toBe("UTC−03:30");
    expect(offsetLabel(0)).toBe("UTC+00:00");
    expect(minuteLabel(DAY)).toBe("24:00");
    expect(minuteLabel(1530)).toBe("01:30");
    expect(wrap(-30, DAY)).toBe(1410);
    expect(setWindowEnd(1380, 60)).toBe(1500);
    expect(setWindowEnd(540, 600)).toBe(600);
    expect(setWindowEnd(540, 540)).toBe(540);
    expect(utcWindowLabel({ id: "x", start_minute: 6 * DAY + 1380, end_minute: WEEK, value: [] }, "weekly")).toBe("Sun 23:00–24:00 UTC");
    expect(utcWindowLabel({ id: "x", start_minute: 15, end_minute: 45, value: [] }, "daily")).toBe("00:15–00:45 UTC");
  });

  it("round trips datetime-local reset anchors without consulting machine timezone", () => {
    const timestamp = Date.UTC(2026, 8, 22, 12, 30);
    expect(localDateTime(timestamp, -345)).toBe("2026-09-22T18:15");
    expect(utcDateTime("2026-09-22T18:15", -345)).toBe(timestamp);
    expect(Number.isNaN(utcDateTime("invalid", 0))).toBe(true);
    expect(Number.isNaN(utcDateTime("2026-02-30T10:00", 0))).toBe(true);
    expect(Number.isNaN(utcDateTime("2026-13-01T10:00", 0))).toBe(true);
  });
});
