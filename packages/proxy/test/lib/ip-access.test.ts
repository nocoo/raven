import { describe, expect, it } from "vitest";
import { normalizeIP, parseRules, allowsIP, resolveClientIP, isLoopback, isPublicIP } from "../../src/lib/ip-access";

describe("IP access policy", () => {
  it("canonicalizes equivalent IPv6 and mapped addresses without conflating loopbacks", () => {
    expect(normalizeIP("2001:0DB8:0000:0:0:0:0:1")).toBe("2001:db8::1");
    for (const value of ["::ffff:192.0.2.1", "0:0:0:0:0:FFFF:c000:201"]) expect(normalizeIP(value)).toBe("192.0.2.1");
    expect(normalizeIP("::1")).toBe("::1");
    expect(normalizeIP("::ffff:0:192.0.2.1")).toBe("::ffff:0:c000:201");
    for (const value of [null, "", "01.2.3.4", "1.2.3.999", "1.2.3.4:80", "[::1]", "fe80::1%en0", "localhost", "::ffff:xx:1"]) expect(normalizeIP(value)).toBeNull();
  });
  it("only permits a matching address when a whitelist is enabled", () => {
    const rules = parseRules(["192.0.2.17/24", "2001:db8:1::7/48", "::1"]);
    for (const ip of ["192.0.2.0", "192.0.2.255", "::ffff:c000:201", "2001:db8:1:ffff:ffff:ffff:ffff:ffff", "::1"]) expect(allowsIP(true, rules, ip)).toBe(true);
    for (const ip of [null, "bad", "192.0.3.0", "2001:db8:2::", "127.0.0.1"]) expect(allowsIP(true, rules, ip)).toBe(false);
    expect(allowsIP(true, [], "192.0.2.1")).toBe(false);
    expect(allowsIP(false, [], null)).toBe(true);
  });
  it("supports exact hosts, family-specific /0 and inclusive ranges", () => {
    expect(allowsIP(true, parseRules(["0.0.0.0/0"]), "::1")).toBe(false);
    expect(allowsIP(true, parseRules(["::/0"]), "192.0.2.1")).toBe(false);
    expect(allowsIP(true, parseRules(["0.0.0.0/0"]), "255.255.255.255")).toBe(true);
    expect(allowsIP(true, parseRules(["::/0"]), "ffff::1")).toBe(true);
    const rules = parseRules(["192.0.2.1-192.0.2.3", "2001:db8::1-2001:db8::3", "::ffff:c000:201/128"]);
    for (const ip of ["192.0.2.1", "192.0.2.3", "2001:db8::1", "2001:db8::3"]) expect(allowsIP(true, rules, ip)).toBe(true);
    for (const ip of ["192.0.2.0", "192.0.2.4", "2001:db8::", "2001:db8::4"]) expect(allowsIP(true, rules, ip)).toBe(false);
    expect(allowsIP(true, parseRules(["2001:db8::1/128"]), "2001:db8::2")).toBe(false);
  });
  it("rejects malformed or ambiguous rules atomically", () => {
    for (const value of [null, {}, [3], [""], ["bad"], ["1.2.3.4/33"], ["::/129"], ["::/-1"], ["::/1/2"], ["::/1x"], ["::ffff:1.2.3.4/95"], ["1.2.3.4-::1"], ["::2-::1"], ["1.2.3.5-1.2.3.4"], ["::1-::2-::3"], ["::1", "bad"], Array(257).fill("::1")]) expect(() => parseRules(value)).toThrow();
    expect(parseRules([" ::1 ", "::1"])).toHaveLength(1);
  });
  it("trusts forwarding only from configured peers, stripping trusted hops right to left", () => {
    const trusted = parseRules(["127.0.0.1", "::1", "10.0.0.0/8"]);
    const headers = new Headers({ "x-forwarded-for": "192.0.2.55, 198.51.100.2, 10.0.0.5", "cf-connecting-ip": "192.0.2.99" });
    expect(resolveClientIP(headers, "127.0.0.1", trusted)).toEqual({ ip: "198.51.100.2", source: "forwarded" });
    expect(resolveClientIP(headers, "203.0.113.1", trusted)).toEqual({ ip: "203.0.113.1", source: "socket" });
    expect(resolveClientIP(headers, null, trusted)).toEqual({ ip: null, source: "unknown" });
    expect(resolveClientIP(new Headers({ "x-forwarded-for": "2001:db8::1" }), "::1", trusted).ip).toBe("2001:db8::1");
    expect(resolveClientIP(new Headers({ "x-real-ip": "192.0.2.1" }), "127.0.0.1", trusted).source).toBe("socket");
    for (const value of ["bad", "1.2.3.4,,10.0.0.1", Array(33).fill("10.0.0.1").join(",")]) expect(resolveClientIP(new Headers({ "x-forwarded-for": value }), "127.0.0.1", trusted).ip).toBeNull();
    expect(resolveClientIP(new Headers({ "x-forwarded-for": "10.0.0.1" }), "127.0.0.1", trusted).ip).toBe("10.0.0.1");
  });
  it("identifies loopback peers and excludes nonpublic lookup targets", () => {
    for (const ip of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:7f00:1"]) expect(isLoopback(ip)).toBe(true);
    for (const ip of [null, "10.0.0.1", "::2", "bad"]) expect(isLoopback(ip)).toBe(false);
    for (const ip of [null, "bad", "127.0.0.1", "::1", "::", "fe80::1", "fd00::1", "10.0.0.1", "100.64.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "224.0.0.1", "ff02::1", "2001:db8::1", "192.0.2.1"]) expect(isPublicIP(ip)).toBe(false);
    for (const ip of ["1.1.1.1", "2606:4700::1111"]) expect(isPublicIP(ip)).toBe(true);
  });
});
