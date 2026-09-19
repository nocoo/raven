import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
const { search } = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock("../../src/lib/server-tools/tavily", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/server-tools/tavily")>(), searchTavily: search,
}))
import { TavilyError } from "../../src/lib/server-tools/tavily"
import { state } from "../../src/lib/state"
import { withServerToolInterception } from "../../src/strategies/support/server-tools"
import type { AnthropicMessagesPayload, AnthropicResponse } from "../../src/protocols/anthropic/types"

const savedKey = state.stWebSearchApiKey
beforeEach(() => { state.stWebSearchApiKey = "synthetic-web-key"; search.mockReset() })
afterEach(() => { state.stWebSearchApiKey = savedKey })
const pure = { hasServerSideTools: true, allServerSide: true, serverSideToolNames: ["web_search"] }
const payload = (messages: unknown[]): AnthropicMessagesPayload => ({ model: "fixture-model", max_tokens: 100, messages, tools: null, tool_choice: null } as AnthropicMessagesPayload)
const answer = { id: "fixture-response", model: "fixture-model", content: [{ type: "text", text: "answer" }] } as AnthropicResponse

describe("server tool boundaries with a mocked search client", () => {
  test.each([
    { messages: [] },
    { messages: [{ role: "assistant", content: "context" }] },
    { messages: [{ role: "user", content: 42 }] },
  ])("does not search without a usable user query: %j", async ({ messages }) => {
    const send = vi.fn().mockResolvedValue(answer)
    expect(await withServerToolInterception(payload(messages), pure, send, "fixture")).toBe(answer)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ tools: null, tool_choice: null })
    expect(search).not.toHaveBeenCalled()
  })

  test("extracts text from mixed user blocks and tolerates missing synthesis metadata", async () => {
    const send = vi.fn().mockResolvedValue({ model: "fixture-model", id: "" })
    search.mockResolvedValueOnce({ content: { type: "web_search_tool_result_error", error_code: "unavailable" }, textContent: "No results" })
    const response = await withServerToolInterception(payload([{ role: "user", content: [{ type: "text", text: "query" }, { type: "image" }, { type: "text", text: 3 }] }]), pure, send, "fixture")
    expect(search).toHaveBeenCalledWith("synthetic-web-key", { query: "query" })
    expect(response.id).toMatch(/^msg_/)
    expect(response.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 })
    expect(response.content?.at(-1)).toEqual({ type: "text", text: "" })
  })

  test("passes numeric paging fields and an absent query through the mixed tool executor", async () => {
    search.mockResolvedValueOnce({ content: [], textContent: "none" })
    const send = vi.fn()
      .mockResolvedValueOnce({ ...answer, content: [{ type: "tool_use", id: "call-1", name: "web_search", input: { count: 2, offset: 0 } }] })
      .mockResolvedValueOnce(answer)
    await withServerToolInterception(payload([{ role: "user", content: "query" }]), { ...pure, allServerSide: false }, send, "fixture")
    expect(search).toHaveBeenCalledWith("synthetic-web-key", { query: "", count: 2, offset: 0 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  test("returns a sparse mixed-mode response without attempting an unnecessary tool loop", async () => {
    const sparse = { id: "fixture", model: "fixture-model" }
    const send = vi.fn().mockResolvedValue(sparse)
    expect(await withServerToolInterception(payload([]), { ...pure, allServerSide: false }, send, "fixture")).toBe(sparse)
    expect(search).not.toHaveBeenCalled()
  })

  test.each([new TavilyError("fixture limit", 429, "rate_limit"), new Error("fixture transport")])("propagates search errors without retrying a live provider: %#", async (error) => {
    search.mockRejectedValueOnce(error)
    const send = vi.fn()
    await expect(withServerToolInterception(payload([{ role: "user", content: "query" }]), pure, send, "fixture")).rejects.toThrow(error.message)
    expect(search).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })
})
