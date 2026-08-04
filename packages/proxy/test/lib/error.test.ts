import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  ClientInputError,
  forwardError,
  HTTPError,
  extractErrorDetails,
} from "../../src/lib/error";
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

  it("returns 400 invalid_request_error for ClientInputError", async () => {
    const app = new Hono();
    app.get("/", (c) => forwardError(c, new ClientInputError("n=2 not allowed")));

    const res = await app.request("/");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("n=2 not allowed");
    expect(body.error.type).toBe("invalid_request_error");
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

  it("maps ClientInputError to statusCode 400 and upstreamStatus null", () => {
    const result = extractErrorDetails(new ClientInputError("bad n"));
    expect(result.statusCode).toBe(400);
    expect(result.upstreamStatus).toBeNull();
    expect(result.errorDetail).toBe("bad n");
  });
});

describe("upstream protocol errors", () => {
  it("maps ResponsesProtocolError to 502 in extract and forward", async () => {
    const err = new Error("proto fail")
    err.name = "ResponsesProtocolError"
    const details = extractErrorDetails(err)
    expect(details.statusCode).toBe(502)
    expect(details.upstreamStatus).toBeNull()

    const app = new Hono()
    app.get("/", (c) => forwardError(c, err))
    const res = await app.request("/")
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.message).toBe("proto fail")
  })

  it("maps ResponsesStreamFailedError to 502", async () => {
    const err = new Error("stream fail")
    err.name = "ResponsesStreamFailedError"
    expect(extractErrorDetails(err).statusCode).toBe(502)
    const app = new Hono()
    app.get("/", (c) => forwardError(c, err))
    expect((await app.request("/")).status).toBe(502)
  })
})
