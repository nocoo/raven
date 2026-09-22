import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const proxyFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/proxy", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/proxy")>(), proxyFetch }));
import { ProxyError } from "@/lib/proxy";
import * as rules from "@/app/api/routing-rules/route";
import * as rule from "@/app/api/routing-rules/[id]/route";
import * as upstreams from "@/app/api/upstreams/route";
import * as upstream from "@/app/api/upstreams/[id]/route";
import * as refresh from "@/app/api/upstreams/[id]/models/refresh/route";
import * as diagnostic from "@/app/api/upstreams/[id]/test/route";
import * as migration from "@/app/api/upstreams/migration/route";
import * as keys from "@/app/api/keys/route";
import * as key from "@/app/api/keys/[id]/route";
import * as copilot from "@/app/api/copilot/[...path]/route";

const ctx = () => ({ params: Promise.resolve({ id: "test:id/slash" }) });
const request = (body = '{"rule_id":"rule:daily"}') => new Request("http://dashboard.test/api/fixture", { method: "POST", body });
const cases: [string, () => Promise<Response>, string, string, number, boolean][] = [
  ["list rules", () => rules.GET(), "/api/routing-rules", "GET", 200, false],
  ["create rule", () => rules.POST(request()), "/api/routing-rules", "POST", 201, true],
  ["read rule", () => rule.GET(request(), ctx()), "/api/routing-rules/test%3Aid%2Fslash", "GET", 200, false],
  ["update rule", () => rule.PUT(request(), ctx()), "/api/routing-rules/test%3Aid%2Fslash", "PUT", 200, true],
  ["delete rule", () => rule.DELETE(request(), ctx()), "/api/routing-rules/test%3Aid%2Fslash", "DELETE", 200, false],
  ["list upstreams", () => upstreams.GET(), "/api/upstreams", "GET", 200, false],
  ["create upstream", () => upstreams.POST(request()), "/api/upstreams", "POST", 201, true],
  ["read upstream", () => upstream.GET(request(), ctx()), "/api/upstreams/test%3Aid%2Fslash", "GET", 200, false],
  ["update upstream", () => upstream.PUT(request(), ctx()), "/api/upstreams/test%3Aid%2Fslash", "PUT", 200, true],
  ["delete upstream", () => upstream.DELETE(request(), ctx()), "/api/upstreams/test%3Aid%2Fslash", "DELETE", 200, false],
  ["refresh catalog", () => refresh.POST(request(), ctx()), "/api/upstreams/test%3Aid%2Fslash/models/refresh", "POST", 200, false],
  ["test upstream", () => diagnostic.POST(request(), ctx()), "/api/upstreams/test%3Aid%2Fslash/test", "POST", 200, true],
  ["migration", () => migration.GET(), "/api/upstreams/migration", "GET", 200, false],
  ["list keys", () => keys.GET(), "/api/keys", "GET", 200, false],
  ["create key", () => keys.POST(request()), "/api/keys", "POST", 201, true],
  ["rebind key", () => key.PATCH(request(), ctx()), "/api/keys/test%3Aid%2Fslash", "PATCH", 200, true],
  ["delete key", () => key.DELETE(request(), ctx()), "/api/keys/test%3Aid%2Fslash", "DELETE", 200, false],
];

beforeEach(() => proxyFetch.mockReset());

describe.each(cases)("Routing BFF: %s", (_name, invoke, path, method, status, body) => {
  it("forwards one request without discovery or payload rewriting", async () => {
    const entity = { id: "saved", quota_status: { remaining_tokens: 12.5 } };
    proxyFetch.mockResolvedValueOnce(entity);
    const response = await invoke();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(entity);
    if (method === "GET") expect(proxyFetch).toHaveBeenCalledExactlyOnceWith(path);
    else expect(proxyFetch).toHaveBeenCalledExactlyOnceWith(path, { method, ...(body ? { body: '{"rule_id":"rule:daily"}' } : {}) });
  });
  it("preserves status, error type and reference conflicts", async () => {
    const detail = { message: "Used by a key", type: "reference_conflict", references: [{ kind: "key", id: "k1", name: "Laptop" }] };
    proxyFetch.mockRejectedValueOnce(new ProxyError(detail.message, 409, detail));
    const response = await invoke();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: detail });
  });
});

describe("BFF trust boundaries", () => {
  it("preserves diagnostic response evidence and catalog HTTP/body details", async () => {
    const details = { operation: "model_discovery" as const, upstream_status: 200, url: "https://fixture.invalid/v1/models", content_type: "application/json", response_body: '{"models":[]}', response_body_truncated: false };
    const detail = { message: "Model discovery did not return a data array", type: "catalog_refresh_failed", details };
    proxyFetch.mockRejectedValueOnce(new ProxyError(detail.message, 503, detail));
    const failure = await refresh.POST(request(), ctx());
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: detail });
    const result = { success: true, answer: "", expected_pong: false, answer_truncated: false, details: { ...details, operation: "generation_test", response_status: "incomplete", finish_reason: "max_output_tokens" } };
    proxyFetch.mockResolvedValueOnce(result);
    expect(await (await diagnostic.POST(request(), ctx())).json()).toEqual(result);
  });
  it.each([
    () => rules.POST(request("bad")), () => rule.PUT(request("bad"), ctx()),
    () => upstreams.POST(request("bad")), () => upstream.PUT(request("bad"), ctx()),
    () => diagnostic.POST(request("bad"), ctx()), () => keys.POST(request("bad")), () => key.PATCH(request("bad"), ctx()),
  ])("rejects malformed JSON before forwarding %#", async invoke => {
    expect((await invoke()).status).toBe(400);
    expect(proxyFetch).not.toHaveBeenCalled();
  });
  it.each([new ProxyError("proxy unavailable"), new Error("network failed"), "unsafe unknown error"])("normalizes non-HTTP failures %#", async error => {
    proxyFetch.mockRejectedValueOnce(error);
    const response = await rules.GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: error instanceof Error ? error.message : "Failed to reach proxy" } });
  });
  it("does not reinterpret malformed upstream JSON as a client request error", async () => {
    proxyFetch.mockRejectedValueOnce(new SyntaxError("invalid proxy JSON"));
    expect((await rules.GET()).status).toBe(502);
  });
  it("forwards diagnostic raw model and strips the removed models refresh GET parameter", async () => {
    proxyFetch.mockResolvedValueOnce({ success: true });
    await diagnostic.POST(request('{"model":"raw/model"}'), ctx());
    expect(proxyFetch).toHaveBeenLastCalledWith("/api/upstreams/test%3Aid%2Fslash/test", { method: "POST", body: '{"model":"raw/model"}' });
    proxyFetch.mockResolvedValueOnce({ data: [] });
    await copilot.GET(new Request("http://dashboard.test/api/copilot/models?refresh=true&scope=all"), { params: Promise.resolve({ path: ["models"] }) });
    expect(proxyFetch).toHaveBeenLastCalledWith("/api/copilot/models?scope=all");
  });
  it("keeps discovery POST-only and removes the old page and live GET route", () => {
    expect("GET" in refresh).toBe(false);
    expect("GET" in diagnostic).toBe(false);
    expect(existsSync(resolve("src/app/api/upstreams/[id]/models/route.ts"))).toBe(false);
    expect(existsSync(resolve("src/app/settings/upstreams/page.tsx"))).toBe(false);
  });
});
