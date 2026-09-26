import { afterEach, expect, it, vi } from "vitest";
import { policyPayload, ipPolicyPath, locateIP } from "@/lib/ip-management";
afterEach(() => vi.restoreAllMocks());
it("builds strict policy payloads and refuses an enabled empty whitelist", () => {
  expect(policyPayload(false, "")).toEqual({ enabled: false, ranges: [] });
  expect(policyPayload(true, " ::1\n\n1.1.1.1\n::1 ")).toEqual({ enabled: true, ranges: ["::1", "1.1.1.1"] });
  expect(policyPayload(false, "", "127.0.0.1\n::1")).toEqual({ enabled: false, ranges: [], trusted_proxies: ["127.0.0.1", "::1"] });
  expect(() => policyPayload(true, "\n ")).toThrow();
  expect(ipPolicyPath()).toBe("/api/ip-policy"); expect(ipPolicyPath("a/b")).toBe("/api/keys/a%2Fb/ip-policy");
});
it("queries through the dashboard and surfaces failures", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ip: "1.1.1.1", location: null }));
  expect(await locateIP("1.1.1.1")).toMatchObject({ ip: "1.1.1.1" });
  expect(mock).toHaveBeenCalledWith("/api/ip-lookup?ip=1.1.1.1", undefined);
  mock.mockResolvedValueOnce(Response.json({ error: { message: "Echo unavailable" } }, { status: 502 }));
  await expect(locateIP("1.1.1.1")).rejects.toThrow("Echo unavailable");
});
it("maps IP series to safe chart keys and fills empty intervals", async () => {
  const { ipActivitySeries } = await import("@/lib/ip-management");
  const series = ipActivitySeries({ keys: ["1.1.1.1", "2001:db8::1"], points: [{ bucket: 60_000, "1.1.1.1": 2 }] }, { from: 60_000, to: 120_000 }, 60_000);
  expect(series.points).toEqual([{ x: 60_000, ip0: 2, ip1: 0 }, { x: 120_000, ip0: 0, ip1: 0 }]);
  expect(series.series).toEqual([{ key: "ip0", label: "1.1.1.1" }, { key: "ip1", label: "2001:db8::1" }]);
});
it("loads and saves global policies through the same management client", async () => {
  const { loadIPPolicy, saveIPPolicy } = await import("@/lib/ip-management");
  const policy = { enabled: false, ranges: [], trusted_proxies: [] };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(policy));
  expect(await loadIPPolicy()).toEqual(policy);
  expect(await saveIPPolicy(policy)).toEqual(policy);
  expect(fetcher.mock.calls[1]?.[1]?.method).toBe("PUT");
});
