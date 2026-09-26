import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { createApiKey, validateApiKey } from "../src/db/keys";
import { readIPPolicy, writeIPPolicy, initIPPolicies } from "../src/db/ip-policy";
import { initDatabase, queryBreakdown } from "../src/db/requests";
import { startRequestSink } from "../src/db/request-sink";
import { state } from "../src/lib/state";
import { parseRules } from "../src/lib/ip-access";
import { checkManagementAccess } from "../src/middleware";
import { COPILOT_RULE_ID } from "../src/core/routing-types";
import { routingFixture } from "./db/routing-fixture";

let fixture: ReturnType<typeof routingFixture>;
let saved: typeof state;
let stop: () => void;
beforeEach(() => {
  saved = { ...state }; fixture = routingFixture(); initDatabase(fixture.db); stop = startRequestSink(fixture.db);
  state.ipWhitelistEnabled = false; state.ipWhitelistRanges = []; state.trustedProxyRanges = [];
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No real upstream"));
});
afterEach(() => { stop(); fixture.close(); Object.assign(state, saved); vi.restoreAllMocks(); });
const app = () => createApp({ db: fixture.db, apiKey: "fixture-api", internalKey: "fixture-management", githubToken: "fixture-github" });
const env = (ip: string | null) => ({ remoteAddress: ip });

describe("IP admission", () => {
  it("initializes existing keys unrestricted without changing secrets or bindings", () => {
    const key = createApiKey(fixture.db, "old", COPILOT_RULE_ID);
    fixture.db.exec("DROP TABLE key_ip_policies"); initIPPolicies(fixture.db); initIPPolicies(fixture.db);
    expect(readIPPolicy(fixture.db, key.id)).toEqual({ enabled: false, ranges: [] });
    expect(validateApiKey(fixture.db, key.key)?.rule_id).toBe(COPILOT_RULE_ID);
    writeIPPolicy(fixture.db, key.id, { enabled: true, ranges: ["::1"] });
    fixture.reopen(); expect(readIPPolicy(fixture.db, key.id)).toEqual({ enabled: true, ranges: ["::1"] });
  });
  it("validates policy writes atomically", () => {
    const key = createApiKey(fixture.db, "key", COPILOT_RULE_ID);
    for (const policy of [{ enabled: true, ranges: [] }, { enabled: true, ranges: ["::/129"] }, { enabled: "true", ranges: [] }, { enabled: false, ranges: [], extra: 1 }]) expect(() => writeIPPolicy(fixture.db, key.id, policy)).toThrow();
    expect(() => writeIPPolicy(fixture.db, "missing", { enabled: false, ranges: [] })).toThrow();
    expect(readIPPolicy(fixture.db, key.id).enabled).toBe(false);
  });
  it("applies both global and key rules and persists denied IP without upstream calls", async () => {
    const key = createApiKey(fixture.db, "restricted", COPILOT_RULE_ID);
    writeIPPolicy(fixture.db, key.id, { enabled: true, ranges: ["2001:db8:1::/48"] });
    state.ipWhitelistEnabled = true; state.ipWhitelistRanges = parseRules(["2001:db8::/32"]);
    for (const ip of ["2001:db8:2::1", "203.0.113.1", null]) {
      const response = await app().request("/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key.key}`, "x-forwarded-for": "2001:db8:1::1" }, body: "{}" }, env(ip));
      expect(response.status).toBe(403);
    }
    const rows = queryBreakdown(fixture.db, { by: "client_ip" });
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(3);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM quota_settlements").get()).toEqual({ count: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect((await app().request("/v1/models", { headers: { Authorization: `Bearer ${key.key}` } }, env("2001:db8:1::1"))).status).toBe(200);
    state.ipWhitelistRanges = parseRules(["192.0.2.0/24"]);
    expect((await app().request("/v1/models", { headers: { Authorization: `Bearer ${key.key}` } }, env("2001:db8:1::1"))).status).toBe(403);
  });
  it("supports disabling a key policy and the env key still follows global policy", async () => {
    const key = createApiKey(fixture.db, "key", COPILOT_RULE_ID);
    writeIPPolicy(fixture.db, key.id, { enabled: true, ranges: ["192.0.2.0/24"] });
    expect((await app().request("/v1/models", { headers: { "x-api-key": key.key } }, env("::ffff:c000:201"))).status).toBe(200);
    writeIPPolicy(fixture.db, key.id, { enabled: false, ranges: [] });
    expect((await app().request("/v1/models", { headers: { "x-api-key": key.key } }, env(null))).status).toBe(200);
    state.ipWhitelistEnabled = true;
    expect((await app().request("/v1/models", { headers: { "x-api-key": "fixture-api" } }, env("::1"))).status).toBe(403);
  });
  it("protects management independently of model policies", async () => {
    state.ipWhitelistEnabled = true;
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect((await app().request("/api/keys", { headers: { Authorization: "Bearer fixture-management" } }, env(peer))).status).toBe(200);
    for (const peer of ["192.0.2.1", null]) expect((await app().request("/api/keys", { headers: { Authorization: "Bearer fixture-management", "x-forwarded-for": "127.0.0.1" } }, env(peer))).status).toBe(403);
    for (const token of ["fixture-api", createApiKey(fixture.db, "key", COPILOT_RULE_ID).key, ""]) expect((await app().request("/api/keys", { headers: { Authorization: `Bearer ${token}` } }, env("::1"))).status).toBe(401);
  });
  it("shares strict local and secret checks with the WebSocket upgrade", () => {
    expect(checkManagementAccess("::1", "secret", "secret")).toBeNull();
    expect(checkManagementAccess("192.0.2.1", "secret", "secret")?.status).toBe(403);
    for (const [token, secret] of [[null, null], ["secret", null], [null, "secret"], ["wrong", "secret"]]) expect(checkManagementAccess("::1", token!, secret!)?.status).toBe(401);
  });
});

describe("IP management API", () => {
  it("reads and atomically updates key and global policies through authenticated HTTP", async () => {
    const key = createApiKey(fixture.db, "managed", COPILOT_RULE_ID);
    const request = (path: string, method = "GET", data?: unknown) => app().request(path, { method, headers: { "x-api-key": "fixture-management", "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }, env("::1"));
    expect(await (await request(`/api/keys/${key.id}/ip-policy`)).json()).toEqual({ enabled: false, ranges: [] });
    expect((await request(`/api/keys/${key.id}/ip-policy`, "PUT", { enabled: true, ranges: ["::1"] })).status).toBe(200);
    expect((await request("/api/keys/missing/ip-policy")).status).toBe(404);
    expect(await (await request("/api/ip-policy")).json()).toEqual({ enabled: false, ranges: [], trusted_proxies: [] });
    const policy = { enabled: true, ranges: ["::1"], trusted_proxies: ["127.0.0.1"] };
    expect(await (await request("/api/ip-policy", "PUT", policy)).json()).toEqual(policy);
    expect(await (await request("/api/ip-policy")).json()).toEqual(policy);
    for (const invalid of [{}, { ...policy, ranges: [] }, { ...policy, trusted_proxies: ["bad"] }, { ...policy, extra: true }]) expect((await request("/api/ip-policy", "PUT", invalid)).status).toBe(400);
    expect(await (await request("/api/ip-policy")).json()).toEqual(policy);
    expect(state.ipWhitelistEnabled).toBe(true);
    expect((await request("/api/ip-policy", "PUT", { enabled: false, ranges: [], trusted_proxies: [] })).status).toBe(200);
    expect(state.ipWhitelistEnabled).toBe(false);
  });
  it("logs normalized IP on admitted models and supports key/IP/time filtering", async () => {
    const key = createApiKey(fixture.db, "stats", COPILOT_RULE_ID);
    await app().request("/v1/models", { headers: { "x-api-key": key.key } }, env("::ffff:c000:201"));
    const response = await app().request(`/api/stats/breakdown?by=client_ip&key_id=${key.id}&client_ip=192.0.2.1&from=1&to=${Date.now() + 1}`, { headers: { "x-api-key": "fixture-management" } }, env("::1"));
    expect(await response.json()).toMatchObject([{ key: "192.0.2.1", count: 1 }]);
    const miss = await app().request(`/api/stats/breakdown?by=client_ip&client_ip=192.0.2.2`, { headers: { "x-api-key": "fixture-management" } }, env("::1"));
    expect(await miss.json()).toEqual([]);
  });
});
