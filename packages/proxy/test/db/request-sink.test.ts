import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Database } from "bun:sqlite"
import { initDatabase, type RequestRecord } from "../../src/db/requests.ts"
import { startRequestSink } from "../../src/db/request-sink.ts"
import { logEmitter } from "../../src/util/log-emitter.ts"
import type { LogEvent } from "../../src/util/log-event.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:")
  initDatabase(db)
  return db
}

function makeRequestEndEvent(
  overrides: Partial<LogEvent> & { data?: Record<string, unknown> } = {},
): LogEvent {
  return {
    ts: Date.now(),
    level: "info",
    type: "request_end",
    requestId: "req_test_123",
    msg: "200 gpt-4o 500ms",
    data: {
      path: "/v1/chat/completions",
      format: "openai",
      model: "gpt-4o",
      resolvedModel: "gpt-4o-2024-08-06",
      stream: false,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 500,
      status: "success",
      statusCode: 200,
      upstreamStatus: 200,
      accountName: "default",
      sessionId: "user_abc_a885da1234",
      clientName: "Claude Code",
      clientVersion: "1.2.3",
      ...overrides.data,
    },
    ...overrides,
    // Ensure data override doesn't get clobbered by spread
  }
}

// ===========================================================================
// request-sink persists request_end events
// ===========================================================================

describe("request-sink", () => {
  let db: Database
  let stopSink: () => void

  beforeEach(() => {
    db = createTestDb()
    stopSink = startRequestSink(db)
  })

  afterEach(() => {
    stopSink()
    db.close()
  })

  test("persists request_end event to DB", () => {
    logEmitter.emitLog(makeRequestEndEvent())

    const rows = db.query("SELECT * FROM requests").all() as RequestRecord[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("req_test_123")
    expect(rows[0]!.path).toBe("/v1/chat/completions")
    expect(rows[0]!.client_format).toBe("openai")
    expect(rows[0]!.model).toBe("gpt-4o")
    expect(rows[0]!.resolved_model).toBe("gpt-4o-2024-08-06")
    expect(rows[0]!.input_tokens).toBe(100)
    expect(rows[0]!.output_tokens).toBe(50)
    expect(rows[0]!.latency_ms).toBe(500)
    expect(rows[0]!.status).toBe("success")
    expect(rows[0]!.status_code).toBe(200)
    expect(rows[0]!.session_id).toBe("user_abc_a885da1234")
    expect(rows[0]!.client_name).toBe("Claude Code")
    expect(rows[0]!.client_version).toBe("1.2.3")
  })

  test("ignores non-request_end events", () => {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "request_start",
      requestId: "req_ignored",
      msg: "start",
    })

    logEmitter.emitLog({
      ts: Date.now(),
      level: "error",
      type: "upstream_error",
      requestId: "req_ignored2",
      msg: "error",
    })

    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "system",
      requestId: null,
      msg: "system message",
    })

    const rows = db.query("SELECT * FROM requests").all()
    expect(rows).toHaveLength(0)
  })

  test("persists error request with error_message", () => {
    logEmitter.emitLog(
      makeRequestEndEvent({
        level: "error",
        requestId: "req_err_456",
        msg: "502 claude-sonnet-4 1200ms",
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: "claude-sonnet-4",
          stream: true,
          latencyMs: 1200,
          status: "error",
          statusCode: 502,
          upstreamStatus: null,
          error: "stream error: connection reset",
          accountName: "test-account",
        },
      }),
    )

    const rows = db.query("SELECT * FROM requests").all() as RequestRecord[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("req_err_456")
    expect(rows[0]!.status).toBe("error")
    expect(rows[0]!.status_code).toBe(502)
    expect(rows[0]!.error_message).toBe("stream error: connection reset")
    expect(rows[0]!.client_format).toBe("anthropic")
    expect(rows[0]!.stream).toBe(1)
    expect(rows[0]!.account_name).toBe("test-account")
  })

  test("multiple events → multiple rows", () => {
    logEmitter.emitLog(
      makeRequestEndEvent({ requestId: "req_1" }),
    )
    logEmitter.emitLog(
      makeRequestEndEvent({ requestId: "req_2" }),
    )
    logEmitter.emitLog(
      makeRequestEndEvent({ requestId: "req_3" }),
    )

    const rows = db.query("SELECT * FROM requests").all()
    expect(rows).toHaveLength(3)
  })

  test("ignores events without requestId", () => {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "request_end",
      requestId: null,
      msg: "no id",
      data: { path: "/v1/chat/completions", model: "gpt-4o" },
    })

    const rows = db.query("SELECT * FROM requests").all()
    expect(rows).toHaveLength(0)
  })

  test("cleanup function removes listener", () => {
    stopSink()

    logEmitter.emitLog(makeRequestEndEvent({ requestId: "req_after_stop" }))

    const rows = db.query("SELECT * FROM requests").all()
    expect(rows).toHaveLength(0)
  })

  test("handles missing data fields gracefully", () => {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "request_end",
      requestId: "req_minimal",
      msg: "minimal event",
      data: {},
    })

    const rows = db.query("SELECT * FROM requests").all() as RequestRecord[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.path).toBe("")
    expect(rows[0]!.model).toBe("")
    expect(rows[0]!.status).toBe("unknown")
  })

  test("persists Anthropic format with translated model", () => {
    logEmitter.emitLog(
      makeRequestEndEvent({
        requestId: "req_anthropic",
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: "claude-sonnet-4-20250514",
          resolvedModel: "Claude Sonnet 4",
          translatedModel: "claude-sonnet-4",
          stream: false,
          inputTokens: 200,
          outputTokens: 100,
          latencyMs: 1500,
          status: "success",
          statusCode: 200,
          upstreamStatus: 200,
          accountName: "default",
        },
      }),
    )

    const rows = db.query("SELECT * FROM requests").all() as RequestRecord[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.client_format).toBe("anthropic")
    expect(rows[0]!.model).toBe("claude-sonnet-4-20250514")
    expect(rows[0]!.resolved_model).toBe("Claude Sonnet 4")
  })

  test("DB error does not throw", () => {
    // Close DB to trigger write error
    db.close()

    // Suppress expected console.error output
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    // Should not throw
    expect(() => {
      logEmitter.emitLog(makeRequestEndEvent({ requestId: "req_db_error" }))
    }).not.toThrow()

    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  test("persists session fields round-trip", () => {
    logEmitter.emitLog(
      makeRequestEndEvent({
        requestId: "req_session_rt",
        data: {
          path: "/v1/messages",
          format: "anthropic",
          model: "claude-sonnet-4",
          stream: false,
          latencyMs: 800,
          status: "success",
          statusCode: 200,
          accountName: "default",
          sessionId: "550e8400-e29b-41d4-a716-446655440000::Claude Code::default",
          clientName: "Claude Code",
          clientVersion: "2.0.0-beta.1",
        },
      }),
    )

    const rows = db.query("SELECT * FROM requests").all() as RequestRecord[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.session_id).toBe("550e8400-e29b-41d4-a716-446655440000::Claude Code::default")
    expect(rows[0]!.client_name).toBe("Claude Code")
    expect(rows[0]!.client_version).toBe("2.0.0-beta.1")
  })

  test("persists null client_version", () => {
    logEmitter.emitLog(
      makeRequestEndEvent({
        requestId: "req_null_cv",
        data: {
          path: "/v1/chat/completions",
          format: "openai",
          model: "gpt-4o",
          stream: false,
          latencyMs: 300,
          status: "success",
          statusCode: 200,
          accountName: "default",
          sessionId: "user_xyz",
          clientName: "Cursor",
          clientVersion: undefined,
        },
      }),
    )

    const rows = db.query("SELECT * FROM requests").all() as RequestRecord[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.session_id).toBe("user_xyz")
    expect(rows[0]!.client_name).toBe("Cursor")
    expect(rows[0]!.client_version).toBeNull()
  })
})
