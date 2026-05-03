/**
 * C.0a — emitUpstreamRawSse shape test.
 *
 * The refactor E2E capture pipeline reads `upstream_raw_sse` log events
 * off the WS bus; this test pins the event shape so capture can rely on
 * `data.event` / `data.data` being present and stable.
 */
import { describe, expect, test } from "vitest"
import { logEmitter } from "../../src/util/log-emitter"
import { emitUpstreamRawSse } from "../../src/util/emit-upstream-raw"
import type { LogEvent } from "../../src/util/log-event"

function collect(run: () => void): LogEvent[] {
  const buf: LogEvent[] = []
  const listener = (ev: LogEvent): void => {
    if (ev.type === "upstream_raw_sse") buf.push(ev)
  }
  logEmitter.on("log", listener)
  try { run() } finally { logEmitter.off("log", listener) }
  return buf
}

describe("emitUpstreamRawSse", () => {
  test("emits a debug-level upstream_raw_sse event with event+data in payload", () => {
    const events = collect(() => {
      emitUpstreamRawSse("req-1", { event: "message_start", data: "{\"type\":\"message_start\"}" })
    })
    expect(events).toHaveLength(1)
    const ev = events[0]!
    expect(ev.level).toBe("debug")
    expect(ev.type).toBe("upstream_raw_sse")
    expect(ev.requestId).toBe("req-1")
    expect(ev.data).toEqual({
      event: "message_start",
      data: "{\"type\":\"message_start\"}",
    })
  })

  test("accepts data-only events (no `event:` field)", () => {
    const events = collect(() => {
      emitUpstreamRawSse("req-2", { data: "[DONE]" })
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toEqual({ event: null, data: "[DONE]" })
  })

  test("treats null event name as null", () => {
    const events = collect(() => {
      emitUpstreamRawSse("req-3", { event: null, data: "x" })
    })
    expect((events[0]!.data as Record<string, unknown>).event).toBeNull()
  })
})
