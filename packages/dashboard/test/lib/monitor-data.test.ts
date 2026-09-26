import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorData, summary } from "../helpers/monitor-fixtures";

const fetchResult = vi.hoisted(() => vi.fn());
vi.mock("@/lib/proxy", () => ({ safeFetch: (path: string) => fetchResult(path) }));
import { loadMonitorData } from "@/lib/monitor-data";

const fixture = monitorData();

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(2_000_000_000);
  fetchResult.mockReset();
  fetchResult.mockImplementation(async (path: string) => {
    const url = new URL(path, "https://raven.test");
    if (url.pathname.endsWith("/summary")) return { ok: true, data: fixture.summary };
    if (url.pathname.endsWith("/timeseries")) return { ok: true, data: fixture.timeseries };
    if (url.pathname.endsWith("/percentiles")) return { ok: true, data: fixture.percentiles };
    if (url.pathname.endsWith("/timeseries-group")) return { ok: true, data: fixture.activity };
    return { ok: true, data: fixture.models };
  });
});

describe("monitor data scope", () => {
  it("uses one time snapshot across all aggregate requests and retains every active filter", async () => {
    const result = await loadMonitorData({ range: "24h", key_id: "key-2", model: "gpt.5", protocol_mode: "native" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.summary).toBe(fixture.summary);
    expect(result.data.distributionTotal).toBe(10);
    expect(result.data.percentiles).toBe(fixture.percentiles);
    expect(result.data.intervalMs).toBe(3_600_000);
    expect(result.data.warnings).toEqual([]);
    const urls = fetchResult.mock.calls.map(([path]) => new URL(path as string, "https://raven.test"));
    expect(urls).toHaveLength(8);
    for (const url of urls) {
      expect(url.searchParams.get("from")).toBe("1913600000");
      expect(url.searchParams.get("to")).toBe("2000000000");
      expect(url.searchParams.get("key_id")).toBe("key-2");
      expect(url.searchParams.get("model")).toBe("gpt.5");
      expect(url.searchParams.get("protocol_mode")).toBe("native");
    }
    expect(urls.some(url => url.pathname.endsWith("timeseries-group"))).toBe(false);
  });

  it("keeps sibling models available without widening the selected model's summary", async () => {
    await loadMonitorData({ range: "custom", from: 0, to: 59_999, model: "selected", key_id: "key-1" }, "model");
    const urls = fetchResult.mock.calls.map(([path]) => new URL(path as string, "https://raven.test"));
    for (const url of urls) {
      expect(url.searchParams.get("key_id")).toBe("key-1");
      if ((url.pathname.endsWith("breakdown") && url.searchParams.get("by") === "model") || (url.pathname.endsWith("summary") && !url.searchParams.has("model"))) expect(url.searchParams.has("model")).toBe(false);
      else expect(url.searchParams.get("model")).toBe("selected");
    }
    expect(urls.filter(url => url.pathname.endsWith("summary")).map(url => url.searchParams.get("model"))).toEqual(["selected", null]);
    expect(urls.find(url => url.pathname.endsWith("timeseries-group"))?.searchParams.get("by")).toBe("model");
    expect(urls.find(url => url.pathname.endsWith("timeseries"))?.searchParams.get("interval")).toBe("minute");
  });

  it("removes both identity filters for the key selector and its total; detail panels stay on the key", async () => {
    const result = await loadMonitorData({ range: "custom", from: 0, to: 1000, key_id: "K2", account: "Editor", model: "M" }, "key_id");
    expect(result.ok && result.data.window).toEqual({ from: 0, to: 1000 });
    const urls = fetchResult.mock.calls.map(([path]) => new URL(path as string, "https://raven.test"));
    const selector = urls.find(url => url.pathname.endsWith("breakdown") && url.searchParams.get("by") === "key_id")!;
    expect(selector.searchParams.has("key_id")).toBe(false);
    expect(selector.searchParams.has("account")).toBe(false);
    expect(selector.searchParams.get("model")).toBe("M");
    const total = urls.find(url => url.pathname.endsWith("summary") && !url.searchParams.has("key_id"))!;
    expect(total.searchParams.has("account")).toBe(false);
    expect(total.searchParams.get("model")).toBe("M");
    const activity = urls.find(url => url.pathname.endsWith("timeseries-group"))!;
    expect(activity.searchParams.get("key_id")).toBe("K2");
  });

  it("keeps the ring total across keys while the detail summary follows the selected key", async () => {
    fetchResult.mockImplementation(async (path: string) => {
      const url = new URL(path, "https://raven.test");
      if (url.pathname.endsWith("summary")) return { ok: true, data: summary({ total_requests: url.searchParams.has("key_id") ? 2 : 80 }) };
      return { ok: true, data: [] };
    });
    const result = await loadMonitorData({ range: "7d", key_id: "K2", protocol_mode: "native" }, "key_id");
    if (!result.ok) throw new Error(result.error);
    expect(result.data.summary.total_requests).toBe(2);
    expect(result.data.distributionTotal).toBe(80);
    const urls = fetchResult.mock.calls.map(([path]) => new URL(path as string, "https://raven.test"));
    expect(urls).toHaveLength(12);
    expect(new Set(urls.map(url => url.searchParams.get("from"))).size).toBe(1);
    expect(urls.every(url => url.searchParams.get("protocol_mode") === "native")).toBe(true);
  });

  it("widens a historical account filter for the ring even without a stable key selection", async () => {
    await loadMonitorData({ range: "24h", account: "Editor" }, "key_id");
    const summaries = fetchResult.mock.calls.map(([path]) => new URL(path as string, "https://raven.test")).filter(url => url.pathname.endsWith("summary"));
    expect(summaries.map(url => url.searchParams.get("account"))).toEqual(["Editor", null]);
  });

  it("marks a missing ring total as unavailable while preserving valid selected details", async () => {
    fetchResult.mockImplementation(async (path: string) => {
      const url = new URL(path, "https://raven.test");
      if (url.pathname.endsWith("summary")) return url.searchParams.has("model") ? { ok: true, data: fixture.summary } : { ok: false, error: "Unavailable" };
      return { ok: true, data: [] };
    });
    const result = await loadMonitorData({ range: "24h", model: "M" }, "model");
    if (!result.ok) throw new Error(result.error);
    expect(result.data.summary).toBe(fixture.summary);
    expect(result.data.distributionTotal).toBeNull();
    expect(result.data.warnings).toEqual(["Distribution total: Unavailable"]);
  });

  it("reports partial panel failures instead of presenting their empty state as zero activity", async () => {
    fetchResult.mockImplementation(async (path: string) => path.includes("/summary") ? { ok: true, data: fixture.summary } : { ok: false, error: "Unavailable" });
    const result = await loadMonitorData({ range: "custom" }, "key_id");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.warnings).toHaveLength(10);
    expect(result.data.warnings).toContain("API keys: Unavailable");
    expect(result.data.models).toEqual([]);
    expect(result.data.percentiles).toBeNull();
    expect(result.data.activity).toEqual({ keys: [], points: [] });
    expect(result.data.window).toEqual({ from: 0, to: 2_000_000_000 });
  });

  it("does not manufacture an all-zero overview when the summary fails", async () => {
    fetchResult.mockResolvedValue({ ok: false, error: "Proxy unavailable" });
    expect(await loadMonitorData({ range: "24h" })).toEqual({ ok: false, error: "Proxy unavailable" });
  });
});

it("loads IP distribution and activity within the selected key and time window", async () => {
  const result = await loadMonitorData({ range: "custom", from: 1, to: 1000, key_id: "selected" }, "key_id");
  expect(result.ok && result.data.ips).toBeDefined();
  const urls = fetchResult.mock.calls.map(([path]) => new URL(path as string, "https://raven.test"));
  const ip = urls.filter(url => url.searchParams.get("by") === "client_ip");
  expect(ip).toHaveLength(2);
  for (const url of ip) { expect(url.searchParams.get("key_id")).toBe("selected"); expect(url.searchParams.get("from")).toBe("1"); expect(url.searchParams.get("to")).toBe("1000"); }
});
