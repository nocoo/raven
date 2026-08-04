// Unit tests for lib/chart-config.ts formatting + derived metrics.
import { describe, expect, it } from "vitest";

import {
  cacheHitRate,
  formatPercent,
  formatCompact,
  formatLatency,
} from "@/lib/chart-config";

describe("cacheHitRate", () => {
  it("divides reads by reads + write + input", () => {
    expect(cacheHitRate(75, 0, 25)).toBeCloseTo(0.75);
  });

  it("counts first-turn writes in the denominator", () => {
    // Two-turn native chat: one write turn then a read-heavy turn. Excluding
    // write would show 99.8%; the real rate is 50%.
    expect(cacheHitRate(8403, 8403, 16)).toBeCloseTo(0.5);
  });

  it("returns 0 when there is input but no cache reads", () => {
    expect(cacheHitRate(0, 0, 100)).toBe(0);
  });

  it("returns 1 when everything is cached", () => {
    expect(cacheHitRate(100, 0, 0)).toBe(1);
  });

  it("returns null when there is nothing to measure", () => {
    expect(cacheHitRate(0, 0, 0)).toBeNull();
  });

  it("returns null for undefined/NaN inputs (older proxy without cache fields)", () => {
    expect(cacheHitRate(undefined as unknown as number, 0, 100)).toBeNull();
    expect(cacheHitRate(50, undefined as unknown as number, 100)).toBeNull();
    expect(cacheHitRate(50, 0, undefined as unknown as number)).toBeNull();
    expect(cacheHitRate(NaN, 0, 100)).toBeNull();
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

  it("degrades undefined/NaN to em-dash instead of throwing", () => {
    expect(formatCompact(undefined as unknown as number)).toBe("—");
    expect(formatCompact(NaN)).toBe("—");
  });
});

describe("formatLatency", () => {
  it("renders ms and s", () => {
    expect(formatLatency(800)).toBe("800ms");
    expect(formatLatency(1200)).toBe("1.2s");
  });
});
