import { describe, expect, it } from "vitest";
import { cacheHitRate } from "@/lib/chart-config";
import { bucketHref, chartActivity, dimensionHref, fillActivity, formatAxisTime, formatMonitorTime, intervalMilliseconds, keyIdentity, keyLabel, monitorHref, monitorInterval, nativeShare, protocolLabel, requestProtocolRoute, tokenSeries, trafficSeries } from "@/lib/monitor";
import { countActiveFilters, filterLabel, filtersToApiQuery, filtersToSearchParams, searchParamsToFilters } from "@/lib/analytics-filters";
import { bucket, request } from "../helpers/monitor-fixtures";

describe("monitor drilldown contract", () => {
  const filters = { range: "custom" as const, from: 65_000, to: 170_000, model: "model.with.dots", key_id: "key&/2", protocol_mode: "translated" as const, status: "error" };

  it("preserves key, model, time and protocol when crossing pages", () => {
    const url = new URL(dimensionHref("key_id", "same-name-key-2", { ...filters, account: "Old name" }), "https://raven.test");
    expect(url.pathname).toBe("/keys");
    expect(searchParamsToFilters(url.searchParams)).toEqual({ ...filters, key_id: "same-name-key-2" });
    expect(url.searchParams.has("account")).toBe(false);
    expect(new URL(dimensionHref("model", "gpt/5?new", filters), url).searchParams.get("model")).toBe("gpt/5?new");
    expect(dimensionHref("client", "Editor", filters)).toContain("/requests?");
    expect(dimensionHref("upstream", "provider", filters)).toContain("upstream=provider");
    expect(dimensionHref("model", "", { range: "24h" })).toBe("/models");
  });

  it("clears only the requested dimension and never carries pagination into links", () => {
    const url = new URL(monitorHref("/models", filters, { model: undefined }), "https://raven.test");
    expect(url.searchParams.has("model")).toBe(false);
    expect(url.searchParams.get("key_id")).toBe("key&/2");
    expect(monitorHref("/", { range: "24h" })).toBe("/");
  });

  it("clamps the selected bucket to the displayed interval with an inclusive upper bound", () => {
    const first = new URL(bucketHref(filters, 60_000, 60_000, { from: 65_000, to: 170_000 }), "https://raven.test");
    expect(searchParamsToFilters(first.searchParams)).toEqual({ ...filters, from: 65_000, to: 119_999 });
    const last = new URL(bucketHref(filters, 120_000, 60_000, { from: 65_000, to: 170_000 }), first);
    expect(last.searchParams.get("to")).toBe("170000");
  });

  it("serializes both new dimensions for API and page URLs, including epoch zero", () => {
    expect(searchParamsToFilters(filtersToSearchParams(filters))).toEqual(filters);
    const api = new URLSearchParams(filtersToApiQuery({ ...filters, from: 0 }));
    expect(api.get("from")).toBe("0");
    expect(api.get("key_id")).toBe("key&/2");
    expect(api.get("protocol_mode")).toBe("translated");
    expect(countActiveFilters(filters)).toBe(4);
    expect(filterLabel("key_id")).toBe("Key");
    expect(filterLabel("protocol_mode")).toBe("Protocol");
    for (const mode of ["native", "unknown"]) expect(searchParamsToFilters(new URLSearchParams({ protocol_mode: mode })).protocol_mode).toBe(mode);
    expect(searchParamsToFilters(new URLSearchParams("protocol_mode=made-up")).protocol_mode).toBeUndefined();
  });
});

describe("honest identity and protocol presentation", () => {
  it("keeps unknown traffic in the native denominator and does not manufacture an empty rate", () => {
    expect(nativeShare({ native_count: 4, translated_count: 3, unknown_count: 3 })).toBe(0.4);
    expect(nativeShare({ native_count: 0, translated_count: 0, unknown_count: 0 })).toBeNull();
    expect(protocolLabel("translated")).toBe("Translated");
  });

  it("marks historical groups without guessing a stable key ID", () => {
    expect(keyLabel({ key: "id-2", account_name: "Editor" })).toBe("Editor");
    expect(keyLabel({ key: "legacy:Editor" })).toBe("Editor");
    expect(keyLabel({ key: "" })).toBe("Unattributed");
    expect(keyIdentity("legacy:Editor")).toBe("Historical name · ID not recorded");
    expect(keyIdentity("id-2")).toBe("id-2");
  });

  it("shows Chat to Responses as an API change even when both use OpenAI formats", () => {
    expect(requestProtocolRoute(request({ client_format: "openai", strategy: "copilot-chat-via-responses", protocol_mode: "translated" }))).toBe("Chat Completions → Responses");
    expect(requestProtocolRoute(request({ client_format: "openai", strategy: "", routing_path: "chat-via-responses" }))).toBe("Chat Completions → Responses");
    expect(requestProtocolRoute(request())).toBe("Messages → Messages");
    expect(requestProtocolRoute(request({ strategy: "custom-openai", protocol_mode: "translated", upstream_format: "openai" }))).toBe("Messages → Chat Completions");
    expect(requestProtocolRoute(request({ strategy: "copilot-translated", protocol_mode: "translated" }))).toBe("Messages → Chat Completions");
    expect(requestProtocolRoute(request({ client_format: "responses", strategy: "copilot-responses" }))).toBe("Responses → Responses");
    expect(requestProtocolRoute(request({ client_format: "missing", strategy: "", protocol_mode: "unknown" }))).toBe("Unknown → Unknown");
  });
});

describe("monitor timelines", () => {
  it("rates only observed cache columns and leaves empty or unobserved buckets null", () => {
    const points = tokenSeries([
      bucket({ cache_read_tokens: 8403, cache_write_tokens: 8403, observed_input_tokens: 16, input_tokens: 20_000, output_tokens: 9_000 }),
      bucket({ bucket: 180_000, input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, observed_input_tokens: 0 }),
    ], { from: 60_000, to: 239_999 }, 60_000);
    expect(points).toHaveLength(3);
    expect(points[0]?.cache_hit_rate).toBeCloseTo(0.4995244, 7);
    expect(points[0]?.cache_hit_rate).not.toBe(cacheHitRate(8403, 8403, 20_000));
    expect(points[0]?.cache_hit_rate).not.toBe(cacheHitRate(8403, 8403, 9_000));
    expect(points[1]).toMatchObject({ bucket: 120_000, input_tokens: 0, output_tokens: 0, cache_hit_rate: null });
    expect(points[2]?.cache_hit_rate).toBeNull();
  });

  it("keeps a measured zero distinct from a missing observation", () => {
    const points = tokenSeries([
      bucket({ cache_read_tokens: 0, cache_write_tokens: 100, observed_input_tokens: 0, input_tokens: 0, output_tokens: 80 }),
      bucket({ bucket: 120_000, cache_read_tokens: 80, cache_write_tokens: 0, observed_input_tokens: 0, input_tokens: 400, output_tokens: 20 }),
      bucket({ bucket: 180_000, cache_read_tokens: 0, cache_write_tokens: 0, observed_input_tokens: 40, output_tokens: 10 }),
      bucket({ bucket: 240_000, cache_read_tokens: 10, cache_write_tokens: 0, observed_input_tokens: undefined as unknown as number, input_tokens: 900, output_tokens: 100 }),
      bucket({ bucket: 300_000, cache_read_tokens: Number.NaN, cache_write_tokens: 0, observed_input_tokens: 10, input_tokens: 10 }),
    ], { from: 60_000, to: 300_000 }, 60_000);
    expect(points.map(point => point.cache_hit_rate)).toEqual([0, 1, 0, null, null]);
    expect(points[1]?.cache_hit_rate).not.toBe(cacheHitRate(80, 0, 400));
    expect(tokenSeries([], { from: Number.NaN, to: 1 }, 60_000)).toEqual([]);
  });

  it("fills traffic gaps with zero requests and missing latency, preserving recorded samples", () => {
    const points = trafficSeries([bucket()], { from: 60_000, to: 239_999 }, 60_000);
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ bucket: 60_000, success_count: 8, error_count: 2, p95_latency_ms: 900, cache_read_tokens: 300 });
    expect(points[1]).toMatchObject({ bucket: 120_000, success_count: 0, p95_latency_ms: null, avg_ttft_ms: null, input_tokens: 0, cache_write_tokens: 0 });
  });

  it("keeps dotted or bracketed model names as data, not Recharts property paths", () => {
    const activity = fillActivity({ keys: ["claude.opus[4]", "Other"], points: [{ bucket: 60_000, "claude.opus[4]": 7 }] }, 60_001, 120_000, 60_000);
    const mapped = chartActivity(activity, { "claude.opus[4]": "Claude" });
    expect(mapped.series).toEqual([{ id: "series_0", key: "claude.opus[4]", label: "Claude" }, { id: "series_1", key: "Other", label: "Other" }]);
    expect(mapped.points).toEqual([{ bucket: 60_000, series_0: 7, series_1: 0 }, { bucket: 120_000, series_0: 0, series_1: 0 }]);
    expect(chartActivity({ keys: ["missing"], points: [{ bucket: 1 }] }, {}).points[0]?.series_0).toBe(0);
  });

  it("bounds gap filling without silently dropping recorded points", () => {
    const data = { keys: ["model"], points: [{ bucket: 60_000, model: 3 }] };
    for (const [from, to, interval] of [[Number.NaN, 1, 60_000], [0, 1, 0], [5, 0, 1]]) expect(fillActivity(data, from!, to!, interval!).points).toEqual([]);
    expect(fillActivity(data, 0, 2_000 * 60_000, 60_000)).toBe(data);
  });

  it("chooses a useful resolution for custom bucket drilldowns", () => {
    expect(monitorInterval({ range: "24h" })).toBe("hour");
    expect(monitorInterval({ range: "custom" })).toBe("hour");
    for (const [to, expected] of [[60_000, "minute"], [7_200_000, "5min"], [86_400_000, "hour"], [2_592_000_000, "day"]] as const) expect(monitorInterval({ range: "custom", from: 0, to })).toBe(expected);
    expect(intervalMilliseconds("day")).toBe(86_400_000);
    expect(intervalMilliseconds("minute")).toBe(60_000);
    expect(intervalMilliseconds("5min")).toBe(300_000);
    expect(intervalMilliseconds("invalid")).toBe(3_600_000);
    expect(formatMonitorTime(0)).toBe("1970-01-01 00:00");
    expect(formatMonitorTime(1234, "second")).toBe("1970-01-01 00:00:01");
    expect(formatMonitorTime(1234, "millisecond")).toBe("1970-01-01 00:00:01.234");
    expect(formatMonitorTime(Number.NaN)).toBe("—");
    expect(formatAxisTime(Number.NaN, 60_000)).toBe("—");
    expect(formatAxisTime(0, 60_000)).toBe("00:00");
    expect(formatAxisTime(0, 86_400_000)).toBe("00:00");
    expect(formatAxisTime(0, 7 * 86_400_000)).toBe("01-01");
  });
});
