import { describe, expect, test, vi } from "vitest"
import { runTypedModelCase, selectTypedModelCases, typedModelCases, typedModelReplyError, type TypedModelCase } from "../typed-model-cases"

const byId = (id: string): TypedModelCase => {
  const entry = typedModelCases.find((item) => item.id === id)
  if (!entry) throw new Error(`Missing case ${id}`)
  return entry
}

const jsonResponse = (payload: unknown, status = 200, contentType = "application/json") =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": contentType } })

const embeddingsReply = jsonResponse({
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 4, total_tokens: 4 },
})

describe("typed model cases", () => {
  test("covers every non-chat typed model with its native path", () => {
    expect(typedModelCases.map((item) => [item.id, item.kind, item.declaredPath, item.path])).toEqual([
      ["text-embedding-3-small.embeddings", "embeddings", null, "/v1/embeddings"],
      ["text-embedding-3-small-inference.embeddings", "embeddings", null, "/v1/embeddings"],
      ["text-embedding-ada-002.embeddings", "embeddings", null, "/v1/embeddings"],
      ["microsoft-decision-1.systemone", "decisions", "/v1/systemone", "/v1/systemone"],
      ["gpt-6-luna-decisions.decisions", "decisions", "/v1/decisions", "/v1/decisions"],
      ["gpt-image-2.5-flare.image", "image", "/v1/images/generations", "/v1/images/generations"],
      ["gpt-41-copilot.completion", "completion", null, "/v1/completions"],
    ])
    for (const item of typedModelCases) {
      expect(item.body.model).toBe(item.model)
      expect(JSON.stringify(typedModelCases)).not.toMatch(/rk-|Bearer/)
    }
  })

  test("selects a finite subset without duplicates", () => {
    expect(selectTypedModelCases([])).toBe(typedModelCases)
    const id = "gpt-image-2.5-flare.image"
    expect(selectTypedModelCases([id, id]).map((item) => item.id)).toEqual([id])
    expect(() => selectTypedModelCases(["missing"])).toThrow("Unknown typed-model case")
  })

  test("sends exactly one native request with no conversion", async () => {
    const entry = byId("text-embedding-3-small.embeddings")
    const spy = vi.fn(async () => embeddingsReply)
    const result = await runTypedModelCase(entry, {
      url: "http://127.0.0.1:7024",
      key: "fixture-key-1234567890",
      fetchImpl: spy as unknown as typeof fetch,
    })
    expect(result.error).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    const [input, init] = spy.mock.calls[0]!
    expect(String(input)).toBe("http://127.0.0.1:7024/v1/embeddings")
    expect(init?.method).toBe("POST")
    expect(init?.redirect).toBe("error")
    expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-key-1234567890" })
    expect(JSON.parse(String(init?.body))).toEqual(entry.body)
  })

  test("reports transport failure without a retry", async () => {
    const spy = vi.fn(async () => { throw new Error("connection refused") })
    const result = await runTypedModelCase(byId("gpt-image-2.5-flare.image"), {
      url: "http://127.0.0.1:7024",
      key: "fixture-key-1234567890",
      fetchImpl: spy as unknown as typeof fetch,
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(0)
    expect(result.error).toContain("transport: connection refused")
  })

  test("redacts the supplied key from the response excerpt", async () => {
    const key = "fixture-key-1234567890"
    const spy = vi.fn(async () => jsonResponse({ error: { message: `bad ${key}` } }))
    const result = await runTypedModelCase(byId("microsoft-decision-1.systemone"), {
      url: "http://127.0.0.1:7024",
      key,
      fetchImpl: spy as unknown as typeof fetch,
    })
    expect(result.excerpt).toContain("[REDACTED]")
    expect(result.excerpt).not.toContain(key)
    expect(result.error).toBe("Response contains an error object")
  })
})

describe("typed model reply validation", () => {
  const text = (payload: unknown) => JSON.stringify(payload)

  test("accepts native embedding, decision, image and completion shapes", () => {
    expect(typedModelReplyError(byId("text-embedding-3-small.embeddings"), 200, "application/json", text({ data: [{ embedding: [0.1] }] }))).toBeNull()
    expect(typedModelReplyError(byId("microsoft-decision-1.systemone"), 200, "application/json", text({ answers: { next_step: { choice: "test" } } }))).toBeNull()
    expect(typedModelReplyError(byId("gpt-6-luna-decisions.decisions"), 200, "application/json", text({ answers: [{ name: "next_step" }] }))).toBeNull()
    expect(typedModelReplyError(byId("gpt-image-2.5-flare.image"), 200, "application/json", text({ data: [{ b64_json: "AA==" }] }))).toBeNull()
    expect(typedModelReplyError(byId("gpt-41-copilot.completion"), 200, "application/json", text({ choices: [{ text: "OK" }] }))).toBeNull()
  })

  test("rejects wrong shapes, non-JSON replies and HTTP errors", () => {
    const entry = byId("text-embedding-3-small.embeddings")
    expect(typedModelReplyError(entry, 404, "application/json", "{}")).toBe("HTTP 404")
    expect(typedModelReplyError(entry, 200, "text/plain", "{}")).toContain("Unexpected content type")
    expect(typedModelReplyError(entry, 200, "application/json", "not json")).toBe("Response is not JSON")
    expect(typedModelReplyError(entry, 200, "application/json", "[]")).toBe("Response is not a JSON object")
    expect(typedModelReplyError(entry, 200, "application/json", text({ error: "no" }))).toBe("Response contains an error object")
    expect(typedModelReplyError(entry, 200, "application/json", text({ data: [] }))).toBe("Missing embedding data")
    expect(typedModelReplyError(entry, 200, "application/json", text({ data: [{ embedding: [] }] }))).toBe("Missing embedding vector")
    expect(typedModelReplyError(byId("microsoft-decision-1.systemone"), 200, "application/json", text({ model: "x" }))).toBe("Missing answers")
    expect(typedModelReplyError(byId("gpt-image-2.5-flare.image"), 200, "application/json", text({ created: 1 }))).toBe("Missing image data")
    expect(typedModelReplyError(byId("gpt-41-copilot.completion"), 200, "application/json", text({ id: "x" }))).toBe("Missing completion output")
  })
})
