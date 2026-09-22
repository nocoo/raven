import { describe, expect, test } from "vitest"
import { declaredProtocols, pickStrategy, type ClientProtocol } from "../../src/core/router"
import type { UpstreamFormat } from "../../src/core/routing-types"
import { upstreamRecord } from "../helpers/routing"

const protocols: ClientProtocol[] = ["anthropic", "openai", "responses"]
const formats: UpstreamFormat[] = ["anthropic_messages", "chat_completions", "responses"]
const expected = [
  ["custom-anthropic", "custom-openai", "protocol-converted"],
  ["protocol-converted", "custom-openai", "protocol-converted"],
  ["protocol-converted", "protocol-converted", "protocol-converted"],
]

describe("endpoint selection after key-bound upstream selection", () => {
  test.each(protocols.flatMap((protocol, source) => formats.map((format, target) => ({ protocol, format, source, target }))))(
    "$protocol to $format uses its native endpoint or explicit adapter", ({ protocol, format, source, target }) => {
      const provider = upstreamRecord({ format })
      const input = { protocol, model: "raw-model", requestedModel: "raw-model", provider, allowConversion: true }
      expect(pickStrategy(input)).toMatchObject({ kind: "ok", name: expected[source]![target], model: "raw-model", providerId: provider.id })
      const off = pickStrategy({ ...input, allowConversion: false })
      expect(off).toMatchObject(source === target ? { kind: "ok" } : { kind: "reject", status: 400, errorType: "protocol_mismatch" })
    },
  )

  test.each(protocols)("Copilot prefers native %s even when all endpoints are advertised", (protocol) => {
    const provider = upstreamRecord({ kind: "copilot", format: null, models: [{ id: "known", supported_endpoints: ["/responses", "/v1/messages", "/chat/completions"] }] })
    expect(pickStrategy({ protocol, model: "known", requestedModel: "auto", provider, allowConversion: false })).toMatchObject({ kind: "ok", upstreamProtocol: protocol })
  })

  test.each([
    ["anthropic", ["/responses"], "protocol-converted", "responses"],
    ["openai", ["/responses"], "copilot-chat-via-responses", "responses"],
    ["responses", ["/chat/completions", "/messages"], "protocol-converted", "openai"],
    ["openai", ["/messages"], "protocol-converted", "anthropic"],
    ["anthropic", ["/responses", "/chat/completions"], "copilot-translated", "openai"],
  ] as const)("Copilot %s chooses the declared priority and honors conversion OFF", (protocol, endpoints, name, upstreamProtocol) => {
    const provider = upstreamRecord({ kind: "copilot", format: null, models: [{ id: "known", supported_endpoints: [...endpoints] }] })
    const input = { protocol, model: "known", requestedModel: "auto", provider, allowConversion: true }
    expect(pickStrategy(input)).toMatchObject({ kind: "ok", name, upstreamProtocol })
    expect(pickStrategy({ ...input, allowConversion: false })).toMatchObject({ kind: "reject", status: 400 })
  })

  test.each([[], [{ id: "different" }], [{ id: "known" }], [{ id: "known", supported_endpoints: ["/unknown"] }]])(
    "unusable Copilot capabilities never guess an endpoint for auto", (...models) => {
      const provider = upstreamRecord({ kind: "copilot", format: null, models: models as never })
      for (const protocol of protocols) {
        expect(pickStrategy({ protocol, model: "known", requestedModel: "auto", provider, allowConversion: true })).toMatchObject({ kind: "reject", status: 503 })
      }
    },
  )

  test.each(protocols)("explicit %s preserves legacy Copilot dispatch with no model membership gate", (protocol) => {
    const provider = upstreamRecord({ kind: "copilot", format: null })
    expect(pickStrategy({ protocol, model: "uncached", requestedModel: "uncached", provider, allowConversion: false })).toMatchObject({ kind: "ok", upstreamProtocol: protocol, model: "uncached" })
    expect(pickStrategy({ protocol, model: "uncached", requestedModel: "uncached", provider, allowConversion: true })).toMatchObject({ kind: "ok", upstreamProtocol: protocol === "anthropic" ? "openai" : protocol })
  })

  test("aliases resolve only inside Copilot, and custom model IDs remain exact", () => {
    const model = "claude-sonnet-4-20250514"
    const provider = upstreamRecord({ kind: "copilot", format: null, models: [{ id: "claude-sonnet-4", supported_endpoints: ["/v1/messages"] }] })
    expect(pickStrategy({ protocol: "anthropic", model, requestedModel: model, provider, allowConversion: true })).toMatchObject({ kind: "ok", name: "copilot-native", model: "claude-sonnet-4" })
    expect(pickStrategy({ protocol: "anthropic", model, requestedModel: model, provider: upstreamRecord({ format: "anthropic_messages" }), allowConversion: false })).toMatchObject({ kind: "ok", model })
  })

  test("missing custom format fails without falling back", () => {
    expect(pickStrategy({ protocol: "openai", model: "raw", requestedModel: "raw", provider: upstreamRecord({ format: null }), allowConversion: true })).toMatchObject({ kind: "reject", status: 503 })
  })

  test("endpoint declarations accept both API path spellings and ignore non-arrays", () => {
    expect(declaredProtocols({ id: "x", supported_endpoints: ["/v1/chat/completions", "/v1/responses", "/messages"] })).toEqual(["openai", "responses", "anthropic"])
    expect(declaredProtocols({ id: "x", supported_endpoints: "invalid" as never })).toEqual([])
    expect(declaredProtocols(undefined)).toEqual([])
  })
})
