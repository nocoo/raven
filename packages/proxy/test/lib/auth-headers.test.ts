import { describe, expect, test } from "vitest"

import { buildProviderAuthHeaders, buildAuthHeaders } from "../../src/lib/auth-headers"

describe("buildAuthHeaders", () => {
  test("bearer style emits Authorization", () => {
    expect(buildAuthHeaders("sk", "bearer")).toEqual({
      Authorization: "Bearer sk",
      "Content-Type": "application/json",
    })
  })

  test("x-api-key style emits x-api-key + anthropic-version", () => {
    expect(buildAuthHeaders("sk", "x-api-key")).toEqual({
      "x-api-key": "sk",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    })
  })
})

describe("saved provider authentication", () => {
  test("Anthropic with no saved style emits both headers in one request", () => {
    expect(buildProviderAuthHeaders({ api_key: "fixture", format: "anthropic_messages", auth_style: null })).toMatchObject({ Authorization: "Bearer fixture", "x-api-key": "fixture", "anthropic-version": "2023-06-01" })
  })
  test("saved styles and single-format defaults are deterministic", () => {
    expect(buildProviderAuthHeaders({ api_key: "fixture", format: "responses", auth_style: null })).toEqual(buildAuthHeaders("fixture", "bearer"))
    expect(buildProviderAuthHeaders({ api_key: "fixture", format: "anthropic_messages", auth_style: "bearer" })).toEqual(buildAuthHeaders("fixture", "bearer"))
    expect(buildProviderAuthHeaders({ api_key: "fixture", format: "chat_completions", auth_style: "x-api-key" })).toEqual(buildAuthHeaders("fixture", "x-api-key"))
  })
})
