import type { ScheduleMode } from "./routing-types";

export const DAY = 1440;
export const WEEK = DAY * 7;
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export interface LocalWindow<T> {
  id: string;
  day: number;
  start: number;
  end: number;
  value: T;
}
export interface UtcWindow<T> {
  id: string;
  start_minute: number;
  end_minute: number;
  value: T;
}

export function wrap(value: number, cycle: number): number {
  return ((value % cycle) + cycle) % cycle;
}

export function minuteLabel(minute: number): string {
  const value = minute === DAY ? DAY : wrap(minute, DAY);
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

export function cycleMinutes(mode: ScheduleMode): number {
  return mode === "weekly" ? WEEK : DAY;
}

export function toUtcWindows<T>(windows: LocalWindow<T>[], mode: ScheduleMode, offset: number): UtcWindow<T>[] {
  if (mode === "all_day") return [];
  const cycle = cycleMinutes(mode);
  const ids = new Set<string>();
  const result: UtcWindow<T>[] = [];
  for (const window of windows) {
    if (!window.id || ids.has(window.id)) throw new Error("Each period needs a unique identity.");
    ids.add(window.id);
    if (![window.day, window.start, window.end].every(Number.isInteger)
      || window.day < 0 || window.day > (mode === "weekly" ? 6 : 0)
      || window.start < 0 || window.start >= DAY || window.end <= window.start
      || window.end - window.start > DAY) {
      throw new Error("Choose a nonempty period of at most 24 hours.");
    }
    let start = wrap(window.day * DAY + window.start + offset, cycle);
    let remaining = window.end - window.start;
    while (remaining > 0) {
      const end = Math.min(Math.floor(start / DAY + 1) * DAY, start + remaining);
      result.push({ id: window.id, start_minute: start, end_minute: end, value: window.value });
      remaining -= end - start;
      start = wrap(end, cycle);
    }
  }
  result.sort((a, b) => a.start_minute - b.start_minute);
  for (let i = 1; i < result.length; i++) {
    if (result[i]!.start_minute < result[i - 1]!.end_minute) {
      throw new Error("Periods overlap, including an overnight tail. Adjust the highlighted day's times before saving.");
    }
  }
  return result;
}

export function toLocalWindows<T>(windows: UtcWindow<T>[], mode: ScheduleMode, offset: number): LocalWindow<T>[] {
  if (mode === "all_day") return [];
  const cycle = cycleMinutes(mode);
  const groups = new Map<string, UtcWindow<T>[]>();
  for (const window of windows) {
    const group = groups.get(window.id) ?? [];
    group.push(window);
    groups.set(window.id, group);
  }
  return Array.from(groups, ([id, fragments]) => {
    const pieces = [...fragments].sort((a, b) => a.start_minute - b.start_minute);
    const first = pieces.find((piece, index) => {
      const previous = pieces[wrap(index - 1, pieces.length)]!;
      return wrap(previous.end_minute, cycle) !== piece.start_minute;
    }) ?? pieces[0]!;
    const duration = pieces.reduce((sum, piece) => sum + piece.end_minute - piece.start_minute, 0);
    const start = cycle === DAY && duration === DAY ? 0 : wrap(first.start_minute - offset, cycle);
    return { id, day: Math.floor(start / DAY), start: start % DAY, end: start % DAY + duration, value: first.value };
  }).sort((a, b) => a.day - b.day || a.start - b.start);
}

export function setWindowEnd(start: number, end: number): number {
  return end < start ? end + DAY : end;
}

export function copyDay<T>(windows: LocalWindow<T>[], source: number, destinations: number[], offset: number, newId: () => string): LocalWindow<T>[] {
  const days = new Set(destinations.filter(day => day !== source));
  const sourceWindows = windows.filter(window => window.day === source);
  const next = windows.filter(window => !days.has(window.day));
  for (const day of days) {
    for (const window of sourceWindows) next.push({ ...structuredClone(window), id: newId(), day });
  }
  toUtcWindows(next, "weekly", offset);
  return next;
}

export function changeScheduleMode<T>(windows: LocalWindow<T>[], from: ScheduleMode, to: ScheduleMode, day: number, newId: () => string): LocalWindow<T>[] {
  if (to === "all_day" || from === "all_day") return [];
  if (from === to) return windows;
  if (to === "daily") return windows.filter(window => window.day === day).map(window => ({ ...window, day: 0 }));
  return DAYS.flatMap((_, index) => windows.map(window => ({ ...structuredClone(window), id: newId(), day: index })));
}

export function daySegments<T>(windows: LocalWindow<T>[], day: number, mode: ScheduleMode): (LocalWindow<T> & { tail: boolean })[] {
  const count = mode === "weekly" ? 7 : 1;
  return windows.flatMap(window => {
    const segments: (LocalWindow<T> & { tail: boolean })[] = [];
    if (window.day === day) segments.push({ ...window, end: Math.min(DAY, window.end), tail: false });
    if (window.end > DAY && wrap(window.day + 1, count) === day) {
      segments.push({ ...window, start: 0, end: window.end - DAY, tail: true });
    }
    return segments;
  });
}

export function localDateTime(timestamp: number, offset: number): string {
  return new Date(timestamp - offset * 60_000).toISOString().slice(0, 16);
}

export function utcDateTime(local: string, offset: number): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return Number.NaN;
  const wallTime = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 16) !== local) return Number.NaN;
  return wallTime + offset * 60_000;
}

export function availableWindow<T>(windows: LocalWindow<T>[], day: number, mode: ScheduleMode): { start: number; end: number } | null {
  const occupied = daySegments(windows, day, mode);
  const starts = [540, ...Array.from({ length: 48 }, (_, index) => index * 30)];
  for (const duration of [60, 30]) {
    for (const start of starts) {
      const end = start + duration;
      if (end <= DAY && occupied.every(window => end <= window.start || start >= window.end)) return { start, end };
    }
  }
  return null;
}
