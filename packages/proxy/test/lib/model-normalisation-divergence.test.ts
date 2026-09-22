import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_UPSTREAM_ID, type UpstreamFormat } from "../../src/core/routing-types"
import { translateModelName } from "../../src/protocols/anthropic/preprocess"
import { state } from "../../src/lib/state"
import { chatResponse, jsonResponse, messageResponse, responsesResponse, routingHarness } from "../helpers/routing"

const raw = "claude-opus-4-6-20250820"
const canonical = "claude-opus-4.6"
let h: ReturnType<typeof routingHarness>
let saved: typeof state
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  h = routingHarness()
  saved = { ...state }
  Object.assign(state, { copilotToken: "fixture-token", rateLimitSeconds: null, stWebSearchEnabled: false })
  fetcher.mockReset()
  vi.stubGlobal("fetch", fetcher)
})
afterEach(() => {
  Object.assign(state, saved)
  vi.unstubAllGlobals()
  h.close()
})

const formats: [UpstreamFormat, unknown][] = [
  ["anthropic_messages", messageResponse(raw)], ["chat_completions", chatResponse(raw)], ["responses", responsesResponse(raw)],
]
describe("driver-local model normalization", () => {
  test("the established dated Copilot alias is preserved", () => {
    expect(translateModelName(raw, null)).toBe(canonical)
  })

  test.each(formats)("custom %s retains a dated raw ID regardless of catalog contents", async (format, response) => {
    const selected = h.upstream({ format, manual_models: [canonical] })
    h.upstream({ name: "Another catalog", manual_models: [raw] })
    h.bind(selected.id, "different-default")
    fetcher.mockResolvedValueOnce(jsonResponse(response))
    const result = await h.request("/v1/messages", { model: raw, max_tokens: 32, messages: [{ role: "user", content: "hello" }] })
    expect(result.status).toBe(200)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).model).toBe(raw)
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer fixture-secret")
  })

  test.each(["/v1/messages", "/chat/completions", "/responses"])("Copilot translates the dated alias before selecting %s", async (endpoint) => {
    h.copilot([{ id: canonical, supported_endpoints: [endpoint] }])
    h.bind(COPILOT_UPSTREAM_ID)
    const response = endpoint === "/v1/messages" ? messageResponse(canonical) : endpoint === "/responses" ? responsesResponse(canonical) : chatResponse(canonical)
    fetcher.mockResolvedValueOnce(jsonResponse(response))
    expect((await h.request("/v1/messages", { model: raw, max_tokens: 32, messages: [{ role: "user", content: "hello" }] })).status).toBe(200)
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://api.githubcopilot.com${endpoint}`)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).model).toBe(canonical)
  })
})
