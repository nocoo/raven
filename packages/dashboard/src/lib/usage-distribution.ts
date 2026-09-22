import type { BreakdownEntry } from "./types";

export function usageDistribution(entries: BreakdownEntry[], total: number | null) {
  const available = entries.reduce((sum, entry) => sum + entry.count, 0);
  const denominator = Math.max(total ?? available, available);
  const slices: { key: string | null; count: number }[] = entries.slice(0, 5).map(entry => ({ key: entry.key, count: entry.count }));
  const others = denominator - slices.reduce((sum, entry) => sum + entry.count, 0);
  if (others > 0) slices.push({ key: null, count: others });
  return { total: denominator, slices };
}
