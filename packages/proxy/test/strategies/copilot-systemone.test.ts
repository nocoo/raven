import { expect, test, vi } from "vitest"
import type { RequestContext } from "../../src/core/context"
import { normalizeUsage } from "../../src/core/usage"
import { buildStrategy } from "../../src/composition/strategy-registry"
import { makeCopilotSystemone } from "../../src/strategies/copilot-systemone"
import { CopilotSystemoneClient } from "../../src/upstream/copilot-systemone"
import { upstreamRecord } from "../helpers/routing"

test("the JSON-only strategy never manufactures stream frames", () => {
  const strategy = makeCopilotSystemone({ client: new CopilotSystemoneClient({
    fetch: vi.fn<typeof fetch>(), getBaseUrl: () => "https://copilot.invalid", getProxyUrl: () => undefined,
    snapshotAuth: () => ({ token: "synthetic", headers: {} }),
  }) })
  const ctx = {} as RequestContext
  const req = { model: "raw-model", state: "fixture", questions: { gate: { type: "noul" } } }
  expect(strategy.initStreamState(req, ctx)).toBeNull()
  expect(strategy.adaptChunk(undefined as never, null, ctx)).toEqual([])
  expect(strategy.adaptStreamError(new Error("stream"), null, ctx)).toEqual([])
  expect(strategy.describeEndLog({ kind: "stream", req, state: null }, ctx)).toEqual({ model: "raw-model" })
  expect(strategy.adaptJson({ status: 304, text: "", contentType: "text/plain", data: null, failed: true }, req, ctx).status).toBe(304)
})

test.each(["systemone", "openai"] as const)("composition rejects a forged conversion decision from %s", clientProtocol => {
  expect(() => buildStrategy({ kind: "ok", name: "protocol-converted", clientProtocol, upstreamProtocol: "systemone", providerId: "fixture", model: "raw" }, {
    provider: upstreamRecord(), toolCallDebug: false,
  })).toThrow("Systemone cannot be converted")
})

test.each([{}, { input_tokens: 0 }, { input_tokens: 0, output_tokens: 0 }, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1.5, output_tokens: Number.MAX_SAFE_INTEGER + 1 }])("usage keeps absent or invalid counters unknown: %j", usage => {
  const result = normalizeUsage("systemone", usage)
  const valid = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  expect(result.input_tokens).toBe(valid(usage.input_tokens) ? usage.input_tokens : null)
  expect(result.output_tokens).toBe(valid(usage.output_tokens) ? usage.output_tokens : null)
  expect(result.complete).toBe(valid(usage.input_tokens) && valid(usage.output_tokens))
  expect(result.cache_read_tokens).toBeNull()
  expect(result.cache_write_tokens).toBeNull()
})
