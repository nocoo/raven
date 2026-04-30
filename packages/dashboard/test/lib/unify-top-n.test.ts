import { describe, it, expect } from "vitest";
import { unifyTopN } from "@/lib/unify-top-n";
import type { ModelStats } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(model: string, count: number, total_tokens: number): ModelStats {
  return { model, count, total_tokens, avg_latency_ms: 100 };
}

// MODEL_TOP_N is 8 in chart-config — tests should work with that constant.

// ===========================================================================
// unifyTopN
// ===========================================================================

describe("unifyTopN", () => {
  it("returns data unchanged when length <= MODEL_TOP_N", () => {
    const data = [
      makeModel("gpt-4o", 10, 1000),
      makeModel("claude-sonnet-4", 5, 500),
    ];
    expect(unifyTopN(data)).toEqual(data);
  });

  it("returns data unchanged when length equals MODEL_TOP_N", () => {
    const data = Array.from({ length: 8 }, (_, i) =>
      makeModel(`model-${i}`, 100 - i, 1000 - i),
    );
    expect(unifyTopN(data)).toEqual(data);
  });

  it("aggregates rest into Others when all top-N overlap", () => {
    // 10 models — top 8 by count and by tokens are the same set
    const data = Array.from({ length: 10 }, (_, i) =>
      makeModel(`model-${i}`, 100 - i * 10, 1000 - i * 100),
    );

    const result = unifyTopN(data);

    // 8 kept + 1 Others = 9
    expect(result).toHaveLength(9);

    const others = result.find((m) => m.model.startsWith("Others"));
    expect(others).toBeDefined();
    expect(others!.model).toBe("Others (2)");
    expect(others!.count).toBe(data[8]!.count + data[9]!.count);
    expect(others!.total_tokens).toBe(data[8]!.total_tokens + data[9]!.total_tokens);
  });

  it("keeps union of top-N by count and top-N by tokens", () => {
    // Construct a case where top-8-by-count ≠ top-8-by-tokens
    // Models 0-7: high count, low tokens
    // Models 8-9: low count, high tokens → should still be kept
    // Model 10: low count, low tokens → should be in Others
    const data: ModelStats[] = [];
    for (let i = 0; i < 8; i++) {
      data.push(makeModel(`high-count-${i}`, 1000 - i, 10 + i));
    }
    data.push(makeModel("high-tokens-a", 1, 50000));
    data.push(makeModel("high-tokens-b", 2, 40000));
    data.push(makeModel("low-both", 3, 5));

    const result = unifyTopN(data);

    const models = result.map((m) => m.model);
    // All high-count models kept (top-8 by count)
    for (let i = 0; i < 8; i++) {
      expect(models).toContain(`high-count-${i}`);
    }
    // Both high-token models kept (top-8 by tokens includes them)
    expect(models).toContain("high-tokens-a");
    expect(models).toContain("high-tokens-b");
    // low-both → folded into Others
    expect(models).not.toContain("low-both");

    const others = result.find((m) => m.model.startsWith("Others"));
    expect(others).toBeDefined();
    expect(others!.model).toBe("Others (1)");
    expect(others!.count).toBe(3);
    expect(others!.total_tokens).toBe(5);
  });

  it("Others avg_latency_ms is mean of rest", () => {
    const data = Array.from({ length: 10 }, (_, i) =>
      makeModel(`m-${i}`, 100 - i * 10, 1000 - i * 100),
    );
    // Override avg_latency_ms for the two that will land in Others
    data[8] = makeModel("m-8", 100 - 80, 1000 - 800);
    data[8].avg_latency_ms = 200;
    data[9] = makeModel("m-9", 100 - 90, 1000 - 900);
    data[9].avg_latency_ms = 400;

    const result = unifyTopN(data);
    const others = result.find((m) => m.model.startsWith("Others"))!;
    expect(others.avg_latency_ms).toBe(300);
  });

  it("preserves input order for kept models", () => {
    // 9 models — first 8 are top by both dimensions, model-extra is Others
    const data = [
      makeModel("z-model", 100, 100),
      makeModel("a-model", 90, 90),
      makeModel("m-model", 80, 80),
      makeModel("b-model", 70, 70),
      makeModel("c-model", 60, 60),
      makeModel("d-model", 50, 50),
      makeModel("e-model", 40, 40),
      makeModel("f-model", 30, 30),
      makeModel("extra", 1, 1),
    ];

    const result = unifyTopN(data);
    const keptNames = result.filter((m) => !m.model.startsWith("Others")).map((m) => m.model);
    // Should match input order, not sorted order
    expect(keptNames).toEqual([
      "z-model", "a-model", "m-model", "b-model",
      "c-model", "d-model", "e-model", "f-model",
    ]);
  });

  it("handles empty input", () => {
    expect(unifyTopN([])).toEqual([]);
  });
});
