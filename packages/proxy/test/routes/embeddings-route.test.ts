import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Hono } from "hono"

import { state } from "../../src/lib/state"
import { embeddingRoutes } from "../../src/routes/embeddings/route"

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.90.0"
  state.accountType = "individual"
  fetchSpy = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  if (savedToken !== undefined) state.copilotToken = savedToken
  else state.copilotToken = null
  fetchSpy.mockRestore()
})

// ===========================================================================
// POST /v1/embeddings — route wrapper
// ===========================================================================

describe("POST /v1/embeddings (route wrapper)", () => {
  const body = JSON.stringify({ input: "hello", model: "text-embedding-ada-002" })
  const headers = { "content-type": "application/json" }

  test("success → returns embedding response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        model: "text-embedding-ada-002",
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }), { status: 200, headers }),
    )

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)
    const res = await app.request("/v1/embeddings", { method: "POST", headers, body })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { model: string }
    expect(json.model).toBe("text-embedding-ada-002")
  })

  test("error → forwardError returns error JSON", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("upstream failed"))

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)
    const res = await app.request("/v1/embeddings", { method: "POST", headers, body })

    expect(res.status).toBe(500)
  })
})
