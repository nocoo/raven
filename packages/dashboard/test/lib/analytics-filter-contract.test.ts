import { describe, expect, it } from "vitest";
import {
  type AnalyticsFilters, type TimeRange, countActiveFilters, filtersToApiQuery,
  filtersToSearchParams, rangeToEpoch, rangeToInterval, searchParamsToFilters,
} from "@/lib/analytics-filters";

describe("complete analytics deep-link contract", () => {
  const filters: AnalyticsFilters = {
    range: "custom", from: 1000, to: 2000, model: "raw/model",
    resolved_model: "resolved/model", strategy: "native", upstream: "fixture-provider",
    account: "fixture-account", client: "fixture-client", client_version: "1.2.3",
    session: "session with spaces", path: "/v1/messages", status: "error",
    status_code: 429, stream: false, has_error: true, min_latency: 0,
    max_latency: 1000, stop_reason: "length", routing_path: "fallback",
  };

  it("round-trips every supported dimension without losing false or zero", () => {
    expect(searchParamsToFilters(filtersToSearchParams(filters))).toEqual(filters);
    expect(countActiveFilters(filters)).toBe(17);
  });

  it("forwards the same complete selection to the proxy API", () => {
    const params = new URLSearchParams(filtersToApiQuery(filters));
    expect(Object.fromEntries(params)).toEqual({
      from: "1000", to: "2000", model: "raw/model", resolved_model: "resolved/model",
      strategy: "native", upstream: "fixture-provider", account: "fixture-account",
      client: "fixture-client", client_version: "1.2.3", session: "session with spaces",
      path: "/v1/messages", status: "error", status_code: "429", stream: "false",
      has_error: "true", min_latency: "0", max_latency: "1000", stop_reason: "length",
      routing_path: "fallback",
    });
  });

  it("does not invent dates for an incomplete custom range", () => {
    expect(filtersToApiQuery({ range: "custom" })).toBe("");
    expect(rangeToInterval("custom")).toBe("hour");
  });

  it("tolerates an unknown range from an old saved URL without inventing epoch bounds", () => {
    const oldRange = "legacy-range" as TimeRange;
    expect(rangeToEpoch(oldRange)).toBeNull();
    expect(filtersToApiQuery({ range: oldRange })).toBe("");
  });
});
