import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { enableTerminalSink, disableTerminalSink, logger } from "../../src/util/logger"
import { logEmitter } from "../../src/util/log-emitter"

// ===========================================================================
// Terminal sink
// ===========================================================================

describe("terminal sink", () => {
  let logSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
    warnSpy = spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    disableTerminalSink()
    logSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  test("enableTerminalSink → logs info events to console.log", () => {
    enableTerminalSink()
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "system",
      msg: "test info",
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  test("enableTerminalSink → logs error events to console.error", () => {
    enableTerminalSink()
    logEmitter.emitLog({
      ts: Date.now(),
      level: "error",
      type: "system",
      msg: "test error",
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  test("enableTerminalSink → logs warn events to console.warn", () => {
    enableTerminalSink()
    logEmitter.emitLog({
      ts: Date.now(),
      level: "warn",
      type: "system",
      msg: "test warn",
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test("disableTerminalSink → stops logging", () => {
    enableTerminalSink()
    disableTerminalSink()
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "system",
      msg: "should not appear",
    })
    expect(logSpy).not.toHaveBeenCalled()
  })

  test("enableTerminalSink is idempotent", () => {
    enableTerminalSink()
    enableTerminalSink() // second call should be no-op
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "system",
      msg: "once only",
    })
    // Should only fire once, not twice
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  test("disableTerminalSink is idempotent", () => {
    disableTerminalSink()
    disableTerminalSink() // second call should be no-op — no crash
    expect(true).toBe(true) // just verify no throw
  })

  test("debug events are suppressed at default info level", () => {
    enableTerminalSink()
    logEmitter.emitLog({
      ts: Date.now(),
      level: "debug",
      type: "system",
      msg: "debug msg",
    })
    expect(logSpy).not.toHaveBeenCalled()
  })

  test("includes requestId and data in JSON output", () => {
    enableTerminalSink()
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "request_end",
      requestId: "req_123",
      msg: "200 gpt-4o 100ms",
      data: { model: "gpt-4o", latencyMs: 100 },
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
    const loggedJson = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(loggedJson.requestId).toBe("req_123")
    expect(loggedJson.model).toBe("gpt-4o")
  })
})

// ===========================================================================
// Logger convenience API
// ===========================================================================

describe("logger convenience API", () => {
  test("logger.debug emits system event", () => {
    const events: unknown[] = []
    logEmitter.on("log", (e: unknown) => events.push(e))
    logger.debug("debug msg")
    logEmitter.removeAllListeners("log")
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  test("logger.info emits system event", () => {
    const events: unknown[] = []
    logEmitter.on("log", (e: unknown) => events.push(e))
    logger.info("info msg")
    logEmitter.removeAllListeners("log")
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  test("logger.warn emits system event", () => {
    const events: unknown[] = []
    logEmitter.on("log", (e: unknown) => events.push(e))
    logger.warn("warn msg")
    logEmitter.removeAllListeners("log")
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  test("logger.error emits system event", () => {
    const events: unknown[] = []
    logEmitter.on("log", (e: unknown) => events.push(e))
    logger.error("error msg")
    logEmitter.removeAllListeners("log")
    expect(events.length).toBeGreaterThanOrEqual(1)
  })
})
