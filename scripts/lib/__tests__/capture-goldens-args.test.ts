import { describe, expect, test } from "vitest"
import { parseCaptureArgs, checkCaptureEnv } from "../capture-goldens-args"

const VALID = ["CopilotNative", "CopilotTranslated"]

describe("parseCaptureArgs", () => {
  test("accepts a known strategy and empty extras", () => {
    const r = parseCaptureArgs(["CopilotNative"], VALID)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.args.strategy).toBe("CopilotNative")
      expect(r.args.extra).toEqual([])
    }
  })

  test("captures extra args after strategy", () => {
    const r = parseCaptureArgs(["CopilotNative", "--timeout", "60000"], VALID)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.args.extra).toEqual(["--timeout", "60000"])
  })

  test("rejects missing strategy", () => {
    const r = parseCaptureArgs([], VALID)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.exitCode).toBe(2)
      expect(r.message).toContain("usage")
      expect(r.message).toContain("CopilotNative")
    }
  })

  test("rejects unknown strategy with the valid list", () => {
    const r = parseCaptureArgs(["Nope"], VALID)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain("unknown strategy: Nope")
      expect(r.message).toContain("CopilotTranslated")
    }
  })
})

describe("checkCaptureEnv", () => {
  test("null (ok) when RAVEN_API_KEY is set", () => {
    expect(checkCaptureEnv({ RAVEN_API_KEY: "rk-x" })).toBeNull()
  })

  test("returns validation error when RAVEN_API_KEY is missing", () => {
    const r = checkCaptureEnv({})
    expect(r?.ok).toBe(false)
    if (r && !r.ok) {
      expect(r.exitCode).toBe(2)
      expect(r.message).toContain("RAVEN_API_KEY")
    }
  })

  test("treats empty string as missing", () => {
    const r = checkCaptureEnv({ RAVEN_API_KEY: "" })
    expect(r?.ok).toBe(false)
  })
})
