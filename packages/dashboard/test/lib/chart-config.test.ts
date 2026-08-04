// Unit tests for lib/chart-config.ts formatting + derived metrics.
import { describe, expect, it } from "vitest";

import {
  cacheHitRate,
  formatPercent,
  formatCompact,
  formatLatency,
} from "@/lib/chart-config";

describe("cacheHitRate", () => {
  it("divides reads by reads + input", () => {
    expect(cacheHitRate(75, 25)).toBeCloseTo(0.75);
  });

  it("returns 0 when there is input but no cache reads", () => {
    expect(cacheHitRate(0, 100)).toBe(0);
  });

  it("returns 1 when everything is cached", () => {
    expect(cacheHitRate(100, 0)).toBe(1);
  });

  it("returns null when there is nothing to measure", () => {
    // No input and no reads — a hit rate of 0% would be misleading.
    expect(cacheHitRate(0, 0)).toBeNull();
  });

  it("returns null for undefined/NaN inputs (older proxy without cache fields)", () => {
    // dev dashboard talks to a proxy that may predate the cache columns;
    // missing fields arrive as undefined and must render "—", not "NaN%".
    expect(cacheHitRate(undefined as unknown as number, 100)).toBeNull();
    expect(cacheHitRate(50, undefined as unknown as number)).toBeNull();
    expect(cacheHitRate(NaN, 100)).toBeNull();
  });
});

describe("formatPercent", () => {
  it("formats 0..1 as one-decimal percentage", () => {
    expect(formatPercent(0.718)).toBe("71.8%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(1)).toBe("100.0%");
  });
});

describe("formatCompact", () => {
  it("uses K/M suffixes", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1500)).toBe("1.5K");
    expect(formatCompact(2_000_000)).toBe("2.0M");
  });
});

describe("formatLatency", () => {
  it("renders ms and s", () => {
    expect(formatLatency(800)).toBe("800ms");
    expect(formatLatency(1200)).toBe("1.2s");
  });
});
