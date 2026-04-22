/**
 * B.5 — fixture format invariants.
 *
 * The §4.3 golden format is frozen here; Phase C captures and Phase H
 * unit fixtures both consume this shape. Breakage is detected at L1
 * so it can't regress silently between a capture run and a replay run.
 */
import { describe, expect, test } from "bun:test"
import {
  assertGoldenFixture,
  parseGoldenFixture,
  serialiseGoldenFixture,
  type GoldenFixture,
} from "../../test/e2e/refactor/fixture-format"

function validFixture(): GoldenFixture {
  return {
    fixtureVersion: 1,
    request: {
      method: "POST",
      path: "/v1/messages",
      body: { model: "m", max_tokens: 1, messages: [] },
    },
    upstream_raw_chunks: [
      { event: "message_start", data: JSON.stringify({ type: "message_start" }) },
      { data: "[DONE]" },
    ],
    expected_client_events: [
      { event: "message_start", data: JSON.stringify({ type: "message_start" }) },
    ],
    expected_end_log: {
      path: "/v1/messages",
      format: "anthropic",
      model: "m",
      stream: true,
      status: "success",
      statusCode: 200,
      upstreamStatus: 200,
      inputTokens: 1,
      outputTokens: 1,
      extras: {},
    },
  }
}

describe("fixture-format", () => {
  test("assertGoldenFixture accepts a valid fixture", () => {
    expect(() => { assertGoldenFixture(validFixture()) }).not.toThrow()
  })

  test("rejects non-object", () => {
    expect(() => { assertGoldenFixture(null) }).toThrow("object")
    expect(() => { assertGoldenFixture("no") }).toThrow("object")
  })

  test("rejects wrong fixtureVersion", () => {
    const bad = { ...validFixture(), fixtureVersion: 2 }
    expect(() => { assertGoldenFixture(bad) }).toThrow("fixtureVersion")
  })

  test("rejects missing request.method", () => {
    const bad = { ...validFixture(), request: { path: "/x", body: {} } }
    expect(() => { assertGoldenFixture(bad) }).toThrow("method")
  })

  test("rejects non-array upstream_raw_chunks", () => {
    const bad = { ...validFixture(), upstream_raw_chunks: "oops" as unknown as [] }
    expect(() => { assertGoldenFixture(bad) }).toThrow("upstream_raw_chunks")
  })

  test("rejects non-array expected_client_events", () => {
    const bad = { ...validFixture(), expected_client_events: {} as unknown as [] }
    expect(() => { assertGoldenFixture(bad) }).toThrow("expected_client_events")
  })

  test("rejects missing end-log fields", () => {
    const bad = validFixture()
    delete (bad.expected_end_log as unknown as Record<string, unknown>).statusCode
    expect(() => { assertGoldenFixture(bad) }).toThrow("statusCode")
  })

  test("parseGoldenFixture round-trips via serialiseGoldenFixture", () => {
    const raw = serialiseGoldenFixture(validFixture())
    expect(raw.endsWith("\n")).toBe(true)
    const round = parseGoldenFixture(raw)
    expect(round.fixtureVersion).toBe(1)
    expect(round.request.path).toBe("/v1/messages")
  })

  test("parseGoldenFixture reports JSON parse errors with context", () => {
    expect(() => parseGoldenFixture("{bad")).toThrow("valid JSON")
  })

  test("serialise refuses to emit a malformed fixture", () => {
    const bad = { ...validFixture(), fixtureVersion: 99 } as unknown as GoldenFixture
    expect(() => serialiseGoldenFixture(bad)).toThrow("fixtureVersion")
  })
})
