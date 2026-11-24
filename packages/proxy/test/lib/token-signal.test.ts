import { describe, expect, test, beforeEach } from "vitest";

import {
  tokenSignal,
  _resetTokenSignalForTest,
  isTokenExpiredBody,
} from "../../src/lib/token-signal";

beforeEach(() => {
  _resetTokenSignalForTest();
});

describe("tokenSignal", () => {
  test("initial state: score = 0, shouldProbeNow = false", () => {
    expect(tokenSignal.readScore()).toBe(0);
    expect(tokenSignal.shouldProbeNow()).toBe(false);
  });

  test("token-expired adds 3 to score", () => {
    tokenSignal.reportAuthFailure("token-expired");
    expect(tokenSignal.readScore()).toBe(3);
  });

  test("other-401 adds 1 to score", () => {
    tokenSignal.reportAuthFailure("other-401");
    expect(tokenSignal.readScore()).toBe(1);
  });

  test("shouldProbeNow is true at exactly threshold (5)", () => {
    tokenSignal.reportAuthFailure("token-expired"); // +3
    tokenSignal.reportAuthFailure("other-401"); // +1
    tokenSignal.reportAuthFailure("other-401"); // +1 → 5
    expect(tokenSignal.readScore()).toBe(5);
    expect(tokenSignal.shouldProbeNow()).toBe(true);
  });

  test("shouldProbeNow is false just below threshold (4)", () => {
    tokenSignal.reportAuthFailure("token-expired"); // +3
    tokenSignal.reportAuthFailure("other-401"); // +1 → 4
    expect(tokenSignal.shouldProbeNow()).toBe(false);
  });

  test("decay reduces score by 1", () => {
    tokenSignal.reportAuthFailure("token-expired"); // 3
    tokenSignal.decay();
    expect(tokenSignal.readScore()).toBe(2);
  });

  test("decay clamps at 0 (does not go negative)", () => {
    tokenSignal.decay();
    tokenSignal.decay();
    tokenSignal.decay();
    expect(tokenSignal.readScore()).toBe(0);
  });

  test("score accumulates across multiple signals", () => {
    tokenSignal.reportAuthFailure("token-expired"); // 3
    tokenSignal.reportAuthFailure("token-expired"); // 6
    expect(tokenSignal.readScore()).toBe(6);
    expect(tokenSignal.shouldProbeNow()).toBe(true);
  });

  test("two token-expired signals (score 6) → 1 decay → still above threshold (5)", () => {
    tokenSignal.reportAuthFailure("token-expired");
    tokenSignal.reportAuthFailure("token-expired");
    tokenSignal.decay(); // 6 → 5
    expect(tokenSignal.shouldProbeNow()).toBe(true);
    tokenSignal.decay(); // 5 → 4
    expect(tokenSignal.shouldProbeNow()).toBe(false);
  });

  test("score is capped (cannot exceed SIGNAL_THRESHOLD * 2 = 10)", () => {
    // Pile on many signals
    for (let i = 0; i < 20; i++) {
      tokenSignal.reportAuthFailure("token-expired");
    }
    expect(tokenSignal.readScore()).toBe(10);
    // After 6 decays we should fall below threshold (10 → 4)
    for (let i = 0; i < 6; i++) tokenSignal.decay();
    expect(tokenSignal.readScore()).toBe(4);
    expect(tokenSignal.shouldProbeNow()).toBe(false);
  });

  test("consumeFreshReport returns true after report; false when drained", () => {
    expect(tokenSignal.consumeFreshReport()).toBe(false);
    tokenSignal.reportAuthFailure("token-expired");
    expect(tokenSignal.consumeFreshReport()).toBe(true);
    // Second consume in a row without new report → false
    expect(tokenSignal.consumeFreshReport()).toBe(false);
  });

  test("decay does NOT count as fresh report", () => {
    tokenSignal.reportAuthFailure("other-401");
    expect(tokenSignal.consumeFreshReport()).toBe(true);
    tokenSignal.decay();
    expect(tokenSignal.consumeFreshReport()).toBe(false);
  });
});

describe("isTokenExpiredBody", () => {
  test("matches simple 'token expired' (case-insensitive)", () => {
    expect(isTokenExpiredBody(401, "token expired")).toBe(true);
    expect(isTokenExpiredBody(401, "Token Expired")).toBe(true);
    expect(isTokenExpiredBody(401, "TOKEN EXPIRED")).toBe(true);
  });

  test("matches JSON-wrapped variants", () => {
    expect(isTokenExpiredBody(401, '{"error":{"message":"token expired"}}')).toBe(true);
    expect(isTokenExpiredBody(401, '{"message":"IDE token expired"}')).toBe(true);
    expect(isTokenExpiredBody(401, '{"error":"the token has expired"}')).toBe(true);
  });

  test("requires both 'token' and 'expired' to appear", () => {
    expect(isTokenExpiredBody(401, "token invalid")).toBe(false);
    expect(isTokenExpiredBody(401, "request expired")).toBe(false);
    expect(isTokenExpiredBody(401, "unauthorized")).toBe(false);
  });

  test("only matches when status is 401", () => {
    expect(isTokenExpiredBody(403, "token expired")).toBe(false);
    expect(isTokenExpiredBody(500, "token expired")).toBe(false);
    expect(isTokenExpiredBody(200, "token expired")).toBe(false);
  });

  test("empty body never matches", () => {
    expect(isTokenExpiredBody(401, "")).toBe(false);
  });
});
