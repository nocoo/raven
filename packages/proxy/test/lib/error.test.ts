import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { forwardError, HTTPError, extractErrorDetails } from "../../src/lib/error";
import { Socks5BridgeUnavailableError } from "../../src/lib/socks5-bridge";

describe("forwardError", () => {
  it("returns upstream status for HTTPError", async () => {
    const app = new Hono();
    app.get("/", (c) => forwardError(c, new HTTPError("Not Found", 404, "no such model")));

    const res = await app.request("/");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toBe("no such model");
  });

  it("returns 502 for Socks5BridgeUnavailableError", async () => {
    const app = new Hono();
    app.get("/", (c) => forwardError(c, new Socks5BridgeUnavailableError()));

    const res = await app.request("/");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toContain("SOCKS5");
  });

  it("returns 500 for generic Error", async () => {
    const app = new Hono();
    app.get("/", (c) => forwardError(c, new Error("something broke")));

    const res = await app.request("/");
    expect(res.status).toBe(500);
  });
});

describe("extractErrorDetails", () => {
  it("maps Socks5BridgeUnavailableError to 502", () => {
    const result = extractErrorDetails(new Socks5BridgeUnavailableError());
    expect(result.statusCode).toBe(502);
    expect(result.upstreamStatus).toBeNull();
  });

  it("maps HTTPError to upstream status", () => {
    const result = extractErrorDetails(new HTTPError("fail", 429, "rate limited"));
    expect(result.statusCode).toBe(429);
    expect(result.upstreamStatus).toBe(429);
  });
});
