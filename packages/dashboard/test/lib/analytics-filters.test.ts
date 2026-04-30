import { describe, expect, it } from "vitest";
import {
  filtersToSearchParams,
  searchParamsToFilters,
  filtersToApiQuery,
  rangeToEpoch,
  rangeToInterval,
  countActiveFilters,
  filterLabel,
  DEFAULT_FILTERS,
  type AnalyticsFilters,
} from "../../src/lib/analytics-filters";

describe("filtersToSearchParams", () => {
  it("returns empty params for defaults", () => {
    const params = filtersToSearchParams(DEFAULT_FILTERS);
    expect(params.toString()).toBe("");
  });

  it("serializes non-default range", () => {
    const params = filtersToSearchParams({ range: "7d" });
    expect(params.get("range")).toBe("7d");
  });

  it("serializes dimension filters", () => {
    const params = filtersToSearchParams({
      range: "24h",
      model: "claude-3",
      strategy: "copilot-native",
      has_error: true,
    });
    expect(params.get("model")).toBe("claude-3");
    expect(params.get("strategy")).toBe("copilot-native");
    expect(params.get("has_error")).toBe("true");
    expect(params.has("range")).toBe(false); // default, not serialized
  });

  it("serializes numeric filters", () => {
    const params = filtersToSearchParams({
      range: "24h",
      status_code: 429,
      min_latency: 100,
      max_latency: 5000,
    });
    expect(params.get("status_code")).toBe("429");
    expect(params.get("min_latency")).toBe("100");
    expect(params.get("max_latency")).toBe("5000");
  });

  it("serializes boolean stream filter", () => {
    const params = filtersToSearchParams({ range: "24h", stream: false });
    expect(params.get("stream")).toBe("false");
  });
});

describe("searchParamsToFilters", () => {
  it("returns defaults for empty params", () => {
    const filters = searchParamsToFilters(new URLSearchParams());
    expect(filters.range).toBe("24h");
    expect(filters.model).toBeUndefined();
  });

  it("parses range", () => {
    const filters = searchParamsToFilters(new URLSearchParams("range=7d"));
    expect(filters.range).toBe("7d");
  });

  it("parses string dimensions", () => {
    const filters = searchParamsToFilters(
      new URLSearchParams("model=gpt-4o&strategy=custom-openai&status=error"),
    );
    expect(filters.model).toBe("gpt-4o");
    expect(filters.strategy).toBe("custom-openai");
    expect(filters.status).toBe("error");
  });

  it("parses numeric values", () => {
    const filters = searchParamsToFilters(
      new URLSearchParams("from=1000&to=2000&status_code=500&min_latency=50"),
    );
    expect(filters.from).toBe(1000);
    expect(filters.to).toBe(2000);
    expect(filters.status_code).toBe(500);
    expect(filters.min_latency).toBe(50);
  });

  it("parses boolean values", () => {
    const filters = searchParamsToFilters(
      new URLSearchParams("stream=true&has_error=true"),
    );
    expect(filters.stream).toBe(true);
    expect(filters.has_error).toBe(true);
  });

  it("stream=false is parsed correctly", () => {
    const filters = searchParamsToFilters(new URLSearchParams("stream=false"));
    expect(filters.stream).toBe(false);
  });
});

describe("roundtrip", () => {
  it("preserves all filters through serialize/deserialize", () => {
    const original: AnalyticsFilters = {
      range: "7d",
      from: 1000,
      to: 2000,
      model: "claude-3",
      strategy: "copilot-native",
      upstream: "provider-1",
      account: "default",
      client: "vscode",
      status: "error",
      status_code: 429,
      stream: true,
      has_error: true,
      min_latency: 100,
      max_latency: 5000,
      stop_reason: "tool_use",
      routing_path: "native",
    };
    const result = searchParamsToFilters(filtersToSearchParams(original));
    expect(result).toEqual(original);
  });
});

describe("filtersToApiQuery", () => {
  it("returns empty string for default filters", () => {
    // Even defaults generate from/to for the time range
    const qs = filtersToApiQuery(DEFAULT_FILTERS);
    expect(qs).toContain("from=");
    expect(qs).toContain("to=");
  });

  it("includes dimension filters in query string", () => {
    const qs = filtersToApiQuery({ range: "24h", model: "claude-3", has_error: true });
    expect(qs).toContain("model=claude-3");
    expect(qs).toContain("has_error=true");
  });

  it("uses from/to for custom range", () => {
    const qs = filtersToApiQuery({ range: "custom", from: 1000, to: 2000 });
    expect(qs).toContain("from=1000");
    expect(qs).toContain("to=2000");
  });
});

describe("rangeToEpoch", () => {
  it("returns null for custom", () => {
    expect(rangeToEpoch("custom")).toBeNull();
  });

  it("returns valid from/to for presets", () => {
    const result = rangeToEpoch("24h");
    expect(result).not.toBeNull();
    expect(result!.to - result!.from).toBe(24 * 60 * 60_000);
  });
});

describe("rangeToInterval", () => {
  it("maps ranges to intervals", () => {
    expect(rangeToInterval("15m")).toBe("minute");
    expect(rangeToInterval("1h")).toBe("minute");
    expect(rangeToInterval("6h")).toBe("5min");
    expect(rangeToInterval("24h")).toBe("hour");
    expect(rangeToInterval("7d")).toBe("hour");
    expect(rangeToInterval("30d")).toBe("day");
  });
});

describe("countActiveFilters", () => {
  it("returns 0 for no dimension filters", () => {
    expect(countActiveFilters({ range: "24h" })).toBe(0);
  });

  it("counts active dimension filters", () => {
    expect(countActiveFilters({ range: "24h", model: "x", status: "error", stream: true })).toBe(3);
  });
});

describe("filterLabel", () => {
  it("returns human-readable labels", () => {
    expect(filterLabel("model")).toBe("Model");
    expect(filterLabel("status_code")).toBe("Status Code");
    expect(filterLabel("routing_path")).toBe("Routing");
  });

  it("returns key for unknown", () => {
    expect(filterLabel("unknown_key")).toBe("unknown_key");
  });
});
