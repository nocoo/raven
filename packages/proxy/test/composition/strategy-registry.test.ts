import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { buildStrategy } from "../../src/composition/strategy-registry"
import { buildContext } from "../../src/core/context"
import { pickStrategy, type ClientProtocol } from "../../src/core/router"
import type { UpstreamFormat } from "../../src/core/routing-types"
import { jsonResponse, messageResponse, upstreamRecord } from "../helpers/routing"

const protocols: [ClientProtocol, UpstreamFormat, string][] = [
  ["anthropic", "anthropic_messages", "/v1/messages"],
  ["openai", "chat_completions", "/chat/completions"],
  ["responses", "responses", "/responses"],
]

describe("strategy registry", () => {
  for (const kind of ["copilot", "custom"] as const) {
    for (const [source] of protocols) {
      for (const [target, format, endpoint] of protocols) {
        test(`${kind} ${source} → ${target} builds the selected strategy`, () => {
          const provider = upstreamRecord({ kind, format: kind === "custom" ? format : null, models: [{ id: "model", supported_endpoints: [endpoint] }] })
          const decision = pickStrategy({ protocol: source, model: "model", requestedModel: "auto", provider, allowConversion: true })
          expect(decision.kind).toBe("ok")
          if (decision.kind !== "ok") throw new Error("Expected accepted decision")
          const strategy = buildStrategy(decision, { toolCallDebug: false, provider })
          expect(strategy.name).toBe(decision.name)
          expect(strategy.adaptStreamError).toBeTypeOf("function")
          expect(strategy.describeEndLog).toBeTypeOf("function")
        })
      }
    }
  }

  test("rejects a non-accepted decision before constructing a client", () => {
    expect(() => buildStrategy({ kind: "reject", status: 400, errorType: "protocol_mismatch", message: "mismatch" }, {
      toolCallDebug: false, provider: upstreamRecord(),
    })).toThrow("accepted endpoint decision")
  })

  test.each([undefined, "prompt-caching-2024-07-31"])("converted Chat reaches the selected Copilot Messages client with beta=%s", async (anthropicBeta) => {
    const model = "Raw.Native-ID"
    const provider = upstreamRecord({ kind: "copilot", format: null, models: [{ id: model, supported_endpoints: ["/v1/messages"] }] })
    const decision = pickStrategy({ protocol: "openai", model, requestedModel: "auto", provider, allowConversion: true })
    expect(decision.kind).toBe("ok")
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(messageResponse(model)))
    const snapshotAuth = vi.fn((options: { anthropicBeta: string | null }) => ({
      token: "fixture-token",
      headers: { authorization: "Bearer fixture-token", ...(options.anthropicBeta ? { "anthropic-beta": options.anthropicBeta } : {}) },
    }))
    const strategy = buildStrategy(decision, {
      toolCallDebug: false, provider, ...(anthropicBeta ? { anthropicBeta } : {}),
      transport: {
        fetch: fetcher,
        allowReplay: false,
        copilotNative: {
          getToken: () => "fixture-token", getBaseUrl: () => "https://copilot.invalid",
          getHeaders: () => ({}), getProxyUrl: () => undefined, snapshotAuth,
        },
      },
    })
    const signal = new AbortController().signal
    const app = new Hono().post("/chat", async (c) => {
      const ctx = buildContext(c, "openai")
      ctx.signal = signal
      const wire = strategy.prepare({ model, stream: false, messages: [{ role: "user", content: "hello" }] }, ctx)
      const result = await strategy.dispatch(wire, ctx)
      if (result.kind !== "json") throw new Error("Expected a JSON completion")
      return Response.json(strategy.adaptJson(result.body, wire, ctx))
    })

    const response = await app.request("/chat", { method: "POST" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ model, choices: [{ message: { role: "assistant", content: "pong" } }] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://copilot.invalid/v1/messages")
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(signal)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ model, stream: false, messages: [{ role: "user" }] })
    expect(snapshotAuth).toHaveBeenCalledWith({ anthropicBeta: anthropicBeta ?? null, visionRequest: false, isAgentCall: false })
  })
})
