import { describe, expect, it } from "vitest";
import { usageDistribution } from "@/lib/usage-distribution";
import { entry } from "../helpers/monitor-fixtures";

describe("usage distribution", () => {
  it("accounts for identities beyond the displayed leaders and the breakdown limit", () => {
    const entries = [50, 40, 30, 20, 10, 5].map((count, index) => entry(`key-${index}`, { count }));
    const result = usageDistribution(entries, 200);
    expect(result.total).toBe(200);
    expect(result.slices).toEqual([
      { key: "key-0", count: 50 }, { key: "key-1", count: 40 }, { key: "key-2", count: 30 },
      { key: "key-3", count: 20 }, { key: "key-4", count: 10 }, { key: null, count: 50 },
    ]);
    expect(result.slices.reduce((sum, slice) => sum + slice.count / result.total, 0)).toBe(1);
  });

  it("keeps a real Others identity and unattributed records distinct from the remainder", () => {
    expect(usageDistribution([entry("Others", { count: 4 }), entry("", { count: 2 })], 10).slices).toEqual([
      { key: "Others", count: 4 }, { key: "", count: 2 }, { key: null, count: 4 },
    ]);
  });

  it("uses only available counts when the full total could not be loaded", () => {
    expect(usageDistribution([entry("A", { count: 3 }), entry("B", { count: 2 })], null)).toEqual({
      total: 5, slices: [{ key: "A", count: 3 }, { key: "B", count: 2 }],
    });
  });

  it("does not produce percentages above 100 when live counts advance between queries", () => {
    expect(usageDistribution([entry("A", { count: 8 }), entry("B", { count: 2 })], 9).total).toBe(10);
  });

  it("keeps an empty distribution empty and retains a known total without breakdown rows", () => {
    expect(usageDistribution([], 0)).toEqual({ total: 0, slices: [] });
    expect(usageDistribution([], null)).toEqual({ total: 0, slices: [] });
    expect(usageDistribution([], 12)).toEqual({ total: 12, slices: [{ key: null, count: 12 }] });
  });
});
