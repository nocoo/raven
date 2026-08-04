import { describe, expect, test } from "vitest"

import {
  isChatEndpoint,
  isResponsesEndpoint,
  isResponsesOnly,
} from "../../../src/protocols/chat-responses/endpoints"

describe("chat-responses/endpoints", () => {
  test("isChatEndpoint accepts both path forms", () => {
    expect(isChatEndpoint("/chat/completions")).toBe(true)
    expect(isChatEndpoint("/v1/chat/completions")).toBe(true)
    expect(isChatEndpoint("/responses")).toBe(false)
    expect(isChatEndpoint("ws:/responses")).toBe(false)
  })

  test("isResponsesEndpoint accepts both path forms, not ws", () => {
    expect(isResponsesEndpoint("/responses")).toBe(true)
    expect(isResponsesEndpoint("/v1/responses")).toBe(true)
    expect(isResponsesEndpoint("ws:/responses")).toBe(false)
    expect(isResponsesEndpoint("/chat/completions")).toBe(false)
  })

  test("isResponsesOnly: empty/missing → false", () => {
    expect(isResponsesOnly(undefined)).toBe(false)
    expect(isResponsesOnly(null)).toBe(false)
    expect(isResponsesOnly([])).toBe(false)
  })

  test("isResponsesOnly: responses-only and ws+responses", () => {
    expect(isResponsesOnly(["/responses"])).toBe(true)
    expect(isResponsesOnly(["/v1/responses"])).toBe(true)
    expect(isResponsesOnly(["/responses", "ws:/responses"])).toBe(true)
  })

  test("isResponsesOnly: chat-only, amphibious, ws-only", () => {
    expect(isResponsesOnly(["/chat/completions"])).toBe(false)
    expect(isResponsesOnly(["/responses", "/chat/completions"])).toBe(false)
    expect(isResponsesOnly(["/v1/responses", "/v1/chat/completions"])).toBe(false)
    expect(isResponsesOnly(["ws:/responses"])).toBe(false)
  })
})
