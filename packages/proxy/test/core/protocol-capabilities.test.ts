import { describe, expect, test } from "vitest"
import { nativeCapabilities } from "../../src/core/protocol-capabilities"
import { nativeProtocolEvidence, type NativeProtocolEvidence } from "../../src/core/protocol-evidence"
import { pickStrategy } from "../../src/core/router"
import { upstreamRecord } from "../helpers/routing"

const evidence: NativeProtocolEvidence[] = [{ upstream: "copilot", model: "fixture", protocol: "responses", stream: false, tested_at: "2026-09-23T00:00:00Z", revision: "a".repeat(40), case_id: "fixture.responses.text.json" }]
const provider = upstreamRecord({ kind: "copilot", format: null, models: [{ id: "fixture", supported_endpoints: ["/chat/completions"] }] })

describe("empirical native capabilities", () => {
  test("keeps protocol, model and JSON/SSE evidence separate", () => {
    expect(nativeCapabilities(provider, "fixture", false, evidence)).toEqual([{ protocol: "responses", evidence: evidence[0] }, { protocol: "openai", evidence: undefined }])
    expect(nativeCapabilities(provider, "fixture", true, evidence)).toEqual([{ protocol: "openai", evidence: undefined }])
    expect(nativeCapabilities(provider, "other", false, evidence)).toEqual([])
  })

  test("does not transfer Copilot evidence to custom providers", () => {
    expect(nativeCapabilities(upstreamRecord({ format: "responses" }), "fixture", false, evidence)).toEqual([{ protocol: "responses", evidence: undefined }])
    expect(nativeCapabilities(upstreamRecord({ format: null }), "fixture", false, evidence)).toEqual([])
  })

  test("uses verified native endpoints not yet advertised, without inferring SSE support", () => {
    const input = { provider, model: "fixture", requestedModel: "auto", protocol: "responses" as const, allowConversion: true }
    expect(pickStrategy(input, evidence)).toMatchObject({ kind: "ok", name: "copilot-responses" })
    expect(pickStrategy({ ...input, stream: true }, evidence)).toMatchObject({ kind: "ok", upstreamProtocol: "openai" })
    expect(pickStrategy({ ...input, stream: true, allowConversion: false }, evidence)).toMatchObject({ kind: "reject", status: 400 })
  })

  test("prefers requested native declarations even when another format has evidence", () => {
    expect(pickStrategy({ provider, model: "fixture", requestedModel: "auto", protocol: "openai", allowConversion: true }, evidence)).toMatchObject({ kind: "ok", upstreamProtocol: "openai" })
    expect(pickStrategy({ provider, model: "fixture", requestedModel: "auto", protocol: "anthropic", allowConversion: true }, evidence)).toMatchObject({ kind: "ok", upstreamProtocol: "responses" })
  })

  test("deduplicates declarations and uses native evidence even with an empty cache", () => {
    const declared = upstreamRecord({ kind: "copilot", models: [{ id: "fixture", supported_endpoints: ["/responses"] }] })
    expect(nativeCapabilities(declared, "fixture", false, evidence)).toHaveLength(1)
    expect(nativeCapabilities({ ...provider, models: [] }, "fixture", false, evidence)[0]?.evidence).toBe(evidence[0])
    expect(nativeCapabilities(provider, "fixture", true)).toEqual([{ protocol: "openai", evidence: undefined }])
  })

  test("shipped evidence is sanitized, uniquely scoped and tied to native text cases", () => {
    const keys = nativeProtocolEvidence.map(entry => `${entry.upstream}:${entry.model}:${entry.protocol}:${entry.stream}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of nativeProtocolEvidence) {
      expect(entry.upstream).toBe("copilot")
      expect(["openai", "anthropic", "responses"]).toContain(entry.protocol)
      expect(entry.revision).toMatch(/^[a-f0-9]{40}$/)
      expect(Number.isFinite(Date.parse(entry.tested_at))).toBe(true)
      const protocol = entry.protocol === "openai" ? "chat" : entry.protocol === "anthropic" ? "messages" : "responses"
      expect(entry.case_id).toBe(`${entry.model}.${protocol}.text.${entry.stream ? "sse" : "json"}`)
      expect(Object.keys(entry).sort()).toEqual(["upstream", "model", "protocol", "stream", "tested_at", "revision", "case_id"].sort())
    }
  })

  test.each([
    ["gemini-3.8-flash", ["/chat/completions"]],
    ["grok-4.5", ["/responses"]],
    ["gpt-5.6-sol", ["/responses"]],
    ["claude-opus-5.5", ["/chat/completions", "/v1/messages"]],
  ])("verified evidence preserves declared routes for %s", (model, endpoints) => {
    const copilot = upstreamRecord({ kind: "copilot", format: null, models: [{ id: model, supported_endpoints: endpoints }] })
    for (const stream of [false, true]) {
      const capabilities = nativeCapabilities(copilot, model, stream)
      expect(capabilities).toHaveLength(endpoints.length)
      expect(capabilities.every(entry => entry.evidence)).toBe(true)
      for (const protocol of ["openai", "responses", "anthropic"] as const) {
        const input = { provider: copilot, model, requestedModel: model, stream, protocol, allowConversion: true }
        expect(pickStrategy(input)).toEqual(pickStrategy(input, []))
      }
    }
  })
})
