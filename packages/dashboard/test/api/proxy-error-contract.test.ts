import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyFetch = vi.fn();
vi.mock("@/lib/proxy", () => {
  class ProxyError extends Error {
    constructor(message: string, public readonly statusCode?: number) { super(message); }
  }
  return { proxyFetch, ProxyError };
});

const { ProxyError } = await import("@/lib/proxy");
const upstreams = await import("@/app/api/upstreams/route");
const upstream = await import("@/app/api/upstreams/[id]/route");
const refreshModels = await import("@/app/api/upstreams/[id]/models/refresh/route");
const keys = await import("@/app/api/keys/route");
const key = await import("@/app/api/keys/[id]/route");
const revoke = await import("@/app/api/keys/[id]/revoke/route");
const settings = await import("@/app/api/settings/route");
const setting = await import("@/app/api/settings/[key]/route");
const requests = await import("@/app/api/requests/route");
const stats = await import("@/app/api/stats/[...path]/route");
const copilot = await import("@/app/api/copilot/[...path]/route");
const connection = await import("@/app/api/connection-info/route");

const request = () => new Request("http://dashboard.test/api/fixture", { method: "POST", body: "{}" });
const context = () => ({ params: Promise.resolve({ id: "fixture-id" }) });
const routes: [string, () => Promise<Response>][] = [
  ["list providers", () => upstreams.GET()],
  ["create provider", () => upstreams.POST(request())],
  ["read provider", () => upstream.GET(request(), context())],
  ["update provider", () => upstream.PUT(request(), context())],
  ["delete provider", () => upstream.DELETE(request(), context())],
  ["refresh provider models", () => refreshModels.POST(request(), context())],
  ["list keys", () => keys.GET()],
  ["create key", () => keys.POST(request())],
  ["delete key", () => key.DELETE(request(), context())],
  ["revoke key", () => revoke.POST(request(), context())],
  ["read settings", () => settings.GET()],
  ["write settings", () => settings.PUT(request())],
  ["delete setting", () => setting.DELETE(request(), { params: Promise.resolve({ key: "fixture" }) })],
  ["requests", () => requests.GET(request())],
  ["statistics", () => stats.GET(request(), { params: Promise.resolve({ path: ["summary"] }) })],
  ["copilot metadata", () => copilot.GET(request(), { params: Promise.resolve({ path: ["user"] }) })],
  ["connection metadata", () => connection.GET()],
];

beforeEach(() => proxyFetch.mockReset());

describe.each(routes)("Dashboard proxy failure contract: %s", (_label, invoke) => {
  it.each([
    [new ProxyError("fixture failure"), 502, "fixture failure"],
    [new ProxyError("fixture failure", 429), 429, "fixture failure"],
    [new Error("fixture failure"), 502, "fixture failure"],
    ["untrusted non-Error rejection", 502, "Failed to reach proxy"],
  ])("normalizes rejection %# without returning success or raw unknown data", async (error, status, message) => {
    proxyFetch.mockRejectedValueOnce(error);
    const response = await invoke();
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain(message);
    expect(JSON.stringify(body)).not.toContain("untrusted non-Error rejection");
    expect(proxyFetch).toHaveBeenCalledOnce();
  });
});
