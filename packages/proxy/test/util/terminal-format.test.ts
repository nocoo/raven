import { describe, expect, test } from "vitest"
import {
  formatTime,
  shortenModel,
  shortenSession,
  formatDuration,
  formatEvent,
} from "../../src/util/terminal-format"
import type { LogEvent } from "../../src/util/log-event"

// ===========================================================================
// Utility functions
// ===========================================================================

describe("formatTime", () => {
  test("formats timestamp to HH:MM:SS", () => {
    // 2024-01-15T09:07:58.000Z — but we need local time, so construct directly
    const d = new Date()
    d.setHours(9, 7, 58, 0)
    expect(formatTime(d.getTime())).toBe("09:07:58")
  })

  test("pads single-digit hours and minutes", () => {
    const d = new Date()
    d.setHours(1, 5, 3, 0)
    expect(formatTime(d.getTime())).toBe("01:05:03")
  })
})

describe("shortenModel", () => {
  test("strips trailing -YYYYMMDD date", () => {
    expect(shortenModel("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet")
  })

  test("strips trailing -YYYY-MM-DD date", () => {
    expect(shortenModel("gpt-5.4-2026-03-05")).toBe("gpt-5.4")
  })

  test("keeps model names without date suffix", () => {
    expect(shortenModel("gpt-4o")).toBe("gpt-4o")
    expect(shortenModel("o3-mini")).toBe("o3-mini")
  })
})

describe("shortenSession", () => {
  test("takes last segment after _ and first 6 chars", () => {
    expect(shortenSession("user_abc_a885da1234567890")).toBe("a885da")
  })

  test("falls back to first 6 chars if no underscore", () => {
    expect(shortenSession("abcdef1234567890")).toBe("abcdef")
  })

  test("handles short session IDs", () => {
    expect(shortenSession("abc")).toBe("abc")
  })

  test(":: format: takes first segment first 6 chars", () => {
    expect(shortenSession("user123::Claude Code::default")).toBe("user12")
  })

  test(":: format: short first segment", () => {
    expect(shortenSession("Cursor::default")).toBe("Cursor")
  })

  test("UUID format", () => {
    expect(shortenSession("550e8400-e29b-41d4-a716-446655440000")).toBe("550e84")
  })

  test(":: format with empty leading segment falls back to 'unknown'", () => {
    expect(shortenSession("::Claude Code::default")).toBe("unknown")
  })
})

describe("formatDuration", () => {
  test("formats >=1000ms as seconds", () => {
    expect(formatDuration(7500)).toBe("7.5s")
    expect(formatDuration(1000)).toBe("1s")
    expect(formatDuration(2400)).toBe("2.4s")
  })

  test("formats <1000ms as milliseconds", () => {
    expect(formatDuration(350)).toBe("350ms")
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("rounds fractional ms", () => {
    expect(formatDuration(350.7)).toBe("351ms")
  })
})

// ===========================================================================
// formatEvent — per event type
// ===========================================================================

describe("formatEvent", () => {
  describe("system events", () => {
    test("info system event includes INF tag and message", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "info",
        type: "system",
        requestId: null,
        msg: "server listening on port 7024",
      }
      const line = formatEvent(event)!
      expect(line).toContain("INF")
      expect(line).toContain("server listening on port 7024")
    })

    test("warn system event includes WRN tag", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "warn",
        type: "system",
        requestId: null,
        msg: "rate limit approaching",
      }
      const line = formatEvent(event)!
      expect(line).toContain("WRN")
      expect(line).toContain("rate limit approaching")
    })

    test("error system event includes ERR tag", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "system",
        requestId: null,
        msg: "fatal error",
      }
      const line = formatEvent(event)!
      expect(line).toContain("ERR")
      expect(line).toContain("fatal error")
    })

    test("debug system event includes DBG tag", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "debug",
        type: "system",
        requestId: null,
        msg: "verbose debug",
      }
      const line = formatEvent(event)!
      expect(line).toContain("DBG")
    })
  })

  describe("request_start", () => {
    test("includes arrow, model (date stripped), stream mode, client, session", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "info",
        type: "request_start",
        requestId: "req_123",
        msg: "POST /v1/messages claude-sonnet-4-20250514",
        data: {
          model: "claude-sonnet-4-20250514",
          stream: true,
          clientName: "Claude Code",
          sessionId: "user_abc_a885da1234",
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("──▶")
      expect(line).toContain("claude-sonnet-4") // date stripped
      expect(line).not.toContain("20250514") // date removed
      expect(line).toContain("stream")
      expect(line).toContain("Claude Code")
      expect(line).toContain("a885da")
    })

    test("shows sync for non-streaming requests", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "info",
        type: "request_start",
        requestId: null,
        msg: "POST /v1/chat/completions gpt-4o",
        data: {
          model: "gpt-4o",
          stream: false,
          clientName: "Cursor",
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("sync")
      expect(line).toContain("gpt-4o") // no date to strip
    })
  })

  describe("request_end — success", () => {
    test("includes model, status, duration, ttft, tokens, client, session", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "info",
        type: "request_end",
        requestId: "req_123",
        msg: "200 claude-sonnet-4-20250514 7500ms",
        data: {
          model: "claude-sonnet-4-20250514",
          statusCode: 200,
          status: "success",
          latencyMs: 7500,
          ttftMs: 2400,
          inputTokens: 243,
          outputTokens: 315,
          clientName: "Claude Code",
          sessionId: "user_abc_a885da1234",
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("◀──")
      expect(line).toContain("claude-sonnet-4")
      expect(line).toContain("200")
      expect(line).toContain("7.5s")
      expect(line).toContain("ttft 2.4s")
      expect(line).toContain("243→315 tok")
      expect(line).toContain("Claude Code")
      expect(line).toContain("a885da")
    })

    test("omits ttft when null", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "info",
        type: "request_end",
        requestId: null,
        msg: "200 gpt-4o 100ms",
        data: {
          model: "gpt-4o",
          statusCode: 200,
          status: "success",
          latencyMs: 100,
          ttftMs: null,
          inputTokens: 50,
          outputTokens: 20,
        },
      }
      const line = formatEvent(event)!
      expect(line).not.toContain("ttft")
    })

    test("prefers resolvedModel over model alias", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "info",
        type: "request_end",
        requestId: "req_123",
        msg: "200 gpt-5-mini 1000ms",
        data: {
          model: "gpt-5-mini", // request alias
          resolvedModel: "gpt-5.4-2026-03-05", // actual model used
          statusCode: 200,
          status: "success",
          latencyMs: 1000,
          ttftMs: 200,
          inputTokens: 100,
          outputTokens: 50,
        },
      }
      const line = formatEvent(event)!
      // Should display resolved model (date stripped), not the alias
      expect(line).toContain("gpt-5.4")
      expect(line).not.toContain("gpt-5-mini")
    })
  })

  describe("request_end — error", () => {
    test("shows error arrow, status, error message", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: "req_456",
        msg: "502 claude-sonnet-4-20250514 3200ms",
        data: {
          model: "claude-sonnet-4-20250514",
          statusCode: 502,
          status: "error",
          latencyMs: 3200,
          error: "upstream timeout",
          clientName: "Claude Code",
          sessionId: "user_abc_a885da1234",
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("✗──")
      expect(line).toContain("502")
      expect(line).toContain("3.2s")
      expect(line).toContain("upstream timeout")
      expect(line).toContain("Claude Code")
    })

    test("truncates verbose error messages", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: "req_456",
        msg: "502 claude-sonnet-4-20250514 7600ms",
        data: {
          model: "claude-sonnet-4-20250514",
          statusCode: 502,
          status: "error",
          latencyMs: 7600,
          error: "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("✗──")
      expect(line).toContain("socket connection was closed unexpectedly")
      expect(line).not.toContain("For more information")
    })

    test("extracts message from JSON error response (OpenAI format)", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: "req_456",
        msg: "400 claude-opus-4 1700ms",
        data: {
          model: "claude-opus-4",
          statusCode: 400,
          status: "error",
          latencyMs: 1700,
          error: 'Failed to create chat completions: {"error":{"message":"The model `claude-opus-4` does not exist or you do not have access to it.","type":"invalid_request_error","param":null,"code":"model_not_found"}}',
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("✗──")
      expect(line).toContain("400")
      // Should extract the actual error message, not show raw JSON
      expect(line).toContain("does not exist or you do not have access")
      expect(line).not.toContain('{"error"')
      expect(line).not.toContain("Failed to create chat completions")
    })

    test("extracts message from simple JSON error response", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: "req_456",
        msg: "429 claude-opus-4 500ms",
        data: {
          model: "claude-opus-4",
          statusCode: 429,
          status: "error",
          latencyMs: 500,
          error: 'Rate limit exceeded: {"message":"Too many requests, please slow down"}',
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("429")
      expect(line).toContain("Too many requests, please slow down")
      expect(line).not.toContain('{"message"')
    })

    test("falls back to plain message when JSON is invalid", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: "req_456",
        msg: "500 claude-opus-4 1000ms",
        data: {
          model: "claude-opus-4",
          statusCode: 500,
          status: "error",
          latencyMs: 1000,
          error: 'Connection failed: {invalid json here',
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("500")
      expect(line).toContain("Connection failed")
    })
  })

  describe("upstream_error", () => {
    test("shows ERR with message and error detail", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "upstream_error",
        requestId: "req_789",
        msg: "upstream error for claude-sonnet-4-20250514",
        data: { error: "connection refused" },
      }
      const line = formatEvent(event)!
      expect(line).toContain("ERR")
      expect(line).toContain("upstream error for claude-sonnet-4-20250514")
      expect(line).toContain("connection refused")
    })
  })

  describe("sse_chunk", () => {
    test("returns null (suppressed)", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "debug",
        type: "sse_chunk",
        requestId: "req_123",
        msg: "chunk",
      }
      expect(formatEvent(event)).toBeNull()
    })
  })

  describe("upstream_raw_sse", () => {
    test("returns null (suppressed)", () => {
      const event: LogEvent = {
        ts: Date.now(),
        level: "debug",
        type: "upstream_raw_sse",
        requestId: "req_123",
        msg: "raw chunk",
      }
      expect(formatEvent(event)).toBeNull()
    })
  })

  describe("unknown event type", () => {
    test("falls back to time + msg", () => {
      const event = {
        ts: Date.now(),
        level: "info",
        type: "totally-unknown",
        requestId: null,
        msg: "fallback message",
      } as unknown as LogEvent
      const line = formatEvent(event)!
      expect(line).toContain("fallback message")
    })
  })

  describe("truncateError boundary lengths", () => {
    test("OpenAI-style JSON error long enough to truncate", () => {
      const longInner = "x".repeat(120)
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: null,
        msg: "500 model 1ms",
        data: {
          model: "gpt-4o",
          statusCode: 500,
          status: "error",
          latencyMs: 1,
          error: `prefix: {"error":{"message":"${longInner}"}}`,
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("…")
      expect(line).toContain("xxxx")
    })

    test("simple JSON {message} long enough to truncate", () => {
      const longInner = "y".repeat(120)
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: null,
        msg: "500 model 1ms",
        data: {
          model: "gpt-4o",
          statusCode: 500,
          status: "error",
          latencyMs: 1,
          error: `prefix: {"message":"${longInner}"}`,
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("…")
      expect(line).toContain("yyyy")
    })

    test("plain message long enough to truncate", () => {
      const long = "z".repeat(200)
      const event: LogEvent = {
        ts: Date.now(),
        level: "error",
        type: "request_end",
        requestId: null,
        msg: "500 model 1ms",
        data: {
          model: "gpt-4o",
          statusCode: 500,
          status: "error",
          latencyMs: 1,
          error: long,
        },
      }
      const line = formatEvent(event)!
      expect(line).toContain("…")
    })
  })
})
