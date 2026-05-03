import { describe, expect, test } from "vitest"
import { mapOpenAIStopReasonToAnthropic } from "../../../src/protocols/translate/stop-reason"

describe("mapOpenAIStopReasonToAnthropic", () => {
  test("stop → end_turn", () => {
    expect(mapOpenAIStopReasonToAnthropic("stop")).toBe("end_turn")
  })

  test("length → max_tokens", () => {
    expect(mapOpenAIStopReasonToAnthropic("length")).toBe("max_tokens")
  })

  test("tool_calls → tool_use", () => {
    expect(mapOpenAIStopReasonToAnthropic("tool_calls")).toBe("tool_use")
  })

  test("content_filter → end_turn", () => {
    expect(mapOpenAIStopReasonToAnthropic("content_filter")).toBe("end_turn")
  })

  test("null → null", () => {
    expect(mapOpenAIStopReasonToAnthropic(null)).toBe(null)
  })
})
