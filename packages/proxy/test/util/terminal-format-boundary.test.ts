import { afterEach, describe, expect, test, vi } from "vitest"
import type { LogEvent } from "../../src/util/log-event"

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe.each([true, false])("terminal formatting with NO_COLOR=%s", (noColor) => {
  test("formats sparse request/error events without exposing undefined fields", async () => {
    vi.stubEnv("NO_COLOR", noColor ? "1" : undefined)
    vi.resetModules()
    const { formatEvent, shortenSession } = await import("../../src/util/terminal-format")
    const base: LogEvent = { ts: 0, level: "info", type: "request_start", requestId: null, msg: "fixture" }
    const start = formatEvent(base)!
    expect(start).toContain("unknown")
    expect(start.includes("\u001b[")).toBe(!noColor)
    const success = formatEvent({ ...base, type: "request_end", data: { statusCode: null } })!
    expect(success).toContain("200")
    expect(success).toContain("0→0 tok")
    expect(success).not.toContain("undefined")
    const failure = formatEvent({ ...base, type: "request_end", data: { status: "error" } })!
    expect(failure).toContain("err")
    expect(failure).not.toContain("undefined")
    expect(formatEvent({ ...base, type: "upstream_error" })).toContain("fixture")
    expect(shortenSession("::")).toBe("unknown")
    expect(shortenSession("")).toBe("unknown")
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(formatEvent({ ...base, type: "system", level })).toContain("fixture")
    }
    expect(formatEvent({ ...base, type: "system", level: "trace" as LogEvent["level"] })).toContain("TRACE")
  })
})
