import { describe, expect, test } from "vitest"
import { liveCases, selectLiveCases, type LiveProtocol } from "../live-proxy-cases"
import { assertLiveReply, inspectFrames, inspectJson, wireObject, type LiveFrame } from "../live-proxy-wire"
import { fixtureFrames, fixtureJson, frame } from "./live-proxy-fixtures"

const item = (protocol: LiveProtocol, tool = false) => liveCases.find((entry) => entry.protocol === protocol && entry.kind === (tool ? "tool" : "text"))!

describe("finite live manifest", () => {
  test("enumerates all 66 cases without duplicate identities or implicit live execution", () => {
    expect(liveCases).toHaveLength(66)
    expect(new Set(liveCases.map((entry) => entry.id)).size).toBe(66)
    expect(liveCases.filter((entry) => entry.kind === "text")).toHaveLength(30)
    expect(liveCases.filter((entry) => entry.kind === "tool")).toHaveLength(24)
    expect(liveCases.filter((entry) => entry.kind === "continuation")).toHaveLength(12)
    expect(liveCases.slice(0, 10).every((entry) => entry.clientFormat === entry.upstreamFormat && entry.kind === "text")).toBe(true)
    expect(liveCases.filter((entry) => entry.model === "auto").every((entry) => entry.resolvedModel === "gpt-5.6-sol")).toBe(true)
    expect(new Set(liveCases.map((entry) => entry.strategy))).toEqual(new Set(["copilot-openai-direct", "copilot-responses", "copilot-native", "copilot-translated", "copilot-chat-via-responses", "protocol-converted"]))
  })

  test.each([
    ["chat", "openai", "copilot-openai-direct"],
    ["messages", "anthropic", "copilot-native"],
    ["responses", "openai", "protocol-converted"],
  ])("keeps Claude %s on the route selected by its dual-protocol catalog", (protocol, upstreamFormat, strategy) => {
    const entries = liveCases.filter((entry) => entry.model === "claude-opus-5.5" && entry.protocol === protocol)
    expect(entries).toHaveLength(5)
    for (const entry of entries) expect(entry).toMatchObject({ upstreamFormat, strategy })
  })

  test("selects exact IDs once in manifest order and rejects typos", () => {
    const ids = [liveCases[2]!.id, liveCases[0]!.id, liveCases[0]!.id]
    expect(selectLiveCases(ids)).toEqual([liveCases[0], liveCases[2]])
    expect(selectLiveCases([])).toBe(liveCases)
    expect(() => selectLiveCases(["not-a-case"])).toThrow("Unknown live case")
  })

  test("supplies matched tool-result histories as one request, without calling tools during the run", () => {
    for (const entry of liveCases.filter((entry) => entry.kind === "continuation")) {
      const body = wireObject(entry.body)
      const history = (body.messages ?? body.input) as Record<string, any>[]
      expect(JSON.stringify(history)).toContain(entry.marker)
      const assistant = history[1]!
      const result = history[2]!
      if (entry.protocol === "chat") expect(assistant.tool_calls[0].id).toBe(result.tool_call_id)
      else if (entry.protocol === "messages") expect(assistant.content[0].id).toBe(result.content[0].tool_use_id)
      else expect(assistant.call_id).toBe(result.call_id)
      expect(entry.stream).toBe(false)
      expect(body.tool_choice).toBeUndefined()
    }
  })
})

describe("client wire acceptance", () => {
  test("permits only the established missing native Chat JSON discriminator", () => {
    const value: any = fixtureJson(item("chat"))
    delete value.object
    expect(inspectJson("chat", value, true).text).toBe(item("chat").marker)
    expect(() => inspectJson("chat", value)).toThrow()
    value.object = "wrong"
    expect(() => inspectJson("chat", value, true)).toThrow()
  })

  test("permits absent streaming usage only when translated Chat did not request it", () => {
    const entry = liveCases.find(value => value.stream && value.upstreamFormat === "openai" && value.protocol !== "chat" && value.kind === "text")!
    const reply = inspectFrames(entry.protocol, fixtureFrames(entry))
    reply.usage = {}
    expect(() => assertLiveReply(entry, reply)).not.toThrow()
    expect(() => assertLiveReply(item("chat"), reply)).toThrow("usage")
  })
  test.each(liveCases.map((entry) => [entry.id, entry] as const))("accepts %s with a different upstream echo model", (_id, entry) => {
    const reply = entry.stream ? inspectFrames(entry.protocol, fixtureFrames(entry)) : inspectJson(entry.protocol, fixtureJson(entry))
    expect(reply.model).toBe("upstream-echo-model")
    expect(() => assertLiveReply(entry, reply)).not.toThrow()
  })

  test.each([null, [], "not-an-object"])("rejects invalid JSON envelopes: %j", (value) => {
    expect(() => inspectJson("chat", value)).toThrow("JSON object")
  })

  test.each([
    ["error envelope", (value: any) => { value.error = { message: "provider failure" } }],
    ["empty ID", (value: any) => { value.id = "" }],
    ["wrong object", (value: any) => { value.object = "not-chat" }],
    ["missing model", (value: any) => { delete value.model }],
    ["missing usage", (value: any) => { delete value.usage }],
    ["missing choices", (value: any) => { delete value.choices }],
    ["multiple choices", (value: any) => { value.choices.push(value.choices[0]) }],
    ["wrong role", (value: any) => { value.choices[0].message.role = "user" }],
  ] as const)("rejects JSON %s", (_name, mutate) => {
    const value = fixtureJson(item("chat"))
    mutate(value)
    expect(() => inspectJson("chat", value)).toThrow()
  })

  test("rejects incomplete Responses and preserves arbitrary non-text output", () => {
    const value: any = fixtureJson(item("responses"))
    value.output.unshift({ type: "reasoning", summary: [] })
    value.output[1].content.unshift({ type: "refusal", refusal: "fixture" })
    expect(inspectJson("responses", value).text).toBe(item("responses").marker)
    value.status = "incomplete"
    expect(() => inspectJson("responses", value)).toThrow("did not complete")
  })

  test.each([
    ["missing marker", (reply: any) => { reply.text = "wrong" }],
    ["unexpected tool", (reply: any) => { reply.tools.push({ id: "x", name: "echo", arguments: "{}" }) }],
    ["truncated output", (reply: any) => { reply.terminal = "length" }],
    ["unknown input usage", (reply: any) => { delete reply.usage.prompt_tokens }],
    ["negative output usage", (reply: any) => { reply.usage.completion_tokens = -1 }],
    ["nonfinite input usage", (reply: any) => { reply.usage.prompt_tokens = Number.POSITIVE_INFINITY }],
  ] as const)("rejects %s", (_name, mutate) => {
    const entry = item("chat")
    const reply = inspectJson("chat", fixtureJson(entry))
    mutate(reply)
    expect(() => assertLiveReply(entry, reply)).toThrow()
  })

  test.each([
    ["no call", (reply: any) => { reply.tools = [] }],
    ["missing call ID", (reply: any) => { reply.tools[0].id = "" }],
    ["wrong function", (reply: any) => { reply.tools[0].name = "other" }],
    ["malformed arguments", (reply: any) => { reply.tools[0].arguments = "{" }],
    ["changed arguments", (reply: any) => { reply.tools[0].arguments = "{}" }],
  ] as const)("rejects tool %s", (_name, mutate) => {
    const entry = item("chat", true)
    const reply = inspectJson("chat", fixtureJson(entry))
    mutate(reply)
    expect(() => assertLiveReply(entry, reply)).toThrow()
  })
})

describe("SSE ordering and completion", () => {
  const mutateData = (frames: LiveFrame[], index: number, mutate: (value: any) => void) => {
    const value = JSON.parse(frames[index]!.data)
    mutate(value)
    frames[index]!.data = JSON.stringify(value)
  }

  test("requires nonempty events and a semantic terminator for every protocol", () => {
    for (const protocol of ["chat", "messages", "responses"] as const) {
      expect(() => inspectFrames(protocol, [])).toThrow("Empty SSE")
      expect(() => inspectFrames(protocol, fixtureFrames(item(protocol)).slice(0, -1))).toThrow()
    }
  })

  test.each([
    ["early DONE", (frames: LiveFrame[]) => { frames.unshift(frame("chat", "[DONE]")) }],
    ["data after DONE", (frames: LiveFrame[]) => { frames.push(frames[0]!) }],
    ["error payload", (frames: LiveFrame[]) => { mutateData(frames, 0, (value) => { value.error = { message: "failure" } }) }],
    ["error event", (frames: LiveFrame[]) => { frames[0]!.event = "error" }],
    ["second choice", (frames: LiveFrame[]) => { mutateData(frames, 0, (value) => { value.choices[0].index = 1 }) }],
    ["text after finish", (frames: LiveFrame[]) => { frames.splice(-2, 0, frames[2]!) }],
    ["duplicate finish", (frames: LiveFrame[]) => { frames.splice(-2, 0, frames.at(-3)!) }],
  ] as const)("rejects Chat %s", (_name, mutate) => {
    const frames = fixtureFrames(item("chat"))
    mutate(frames)
    expect(() => inspectFrames("chat", frames)).toThrow()
  })

  test("rejects Chat tool chunks after finish and chunks without a call index", () => {
    const entry = item("chat", true)
    const frames = fixtureFrames(entry)
    frames.splice(-2, 0, frames[1]!)
    expect(() => inspectFrames("chat", frames)).toThrow("after finish")
    const missing = fixtureFrames(entry)
    mutateData(missing, 1, (value) => { delete value.choices[0].delta.tool_calls[0].index })
    expect(() => inspectFrames("chat", missing)).toThrow("tool index")
  })

  test.each([
    ["data after stop", (frames: LiveFrame[]) => { frames.push(frames[0]!) }],
    ["error", (frames: LiveFrame[]) => { frames.unshift(frame("messages", { type: "error" })) }],
    ["header mismatch", (frames: LiveFrame[]) => { frames[0]!.event = "other" }],
    ["duplicate start", (frames: LiveFrame[]) => { frames.splice(2, 0, frames[1]!) }],
    ["missing start", (frames: LiveFrame[]) => { frames.splice(1, 1) }],
    ["duplicate block", (frames: LiveFrame[]) => { frames.splice(3, 0, frames[2]!) }],
    ["delta before block", (frames: LiveFrame[]) => { frames.splice(2, 1) }],
    ["delta after block stop", (frames: LiveFrame[]) => { frames.splice(5, 0, frames[3]!) }],
    ["open block at message delta", (frames: LiveFrame[]) => { frames.splice(7, 1) }],
    ["premature stop", (frames: LiveFrame[]) => { frames.splice(3, 0, frame("messages", { type: "message_stop" })) }],
  ] as const)("rejects Messages %s", (_name, mutate) => {
    const frames = fixtureFrames(item("messages"))
    mutate(frames)
    expect(() => inspectFrames("messages", frames)).toThrow()
  })

  test("accepts an initial complete tool input and harmless extensions", () => {
    const entry = item("messages", true)
    const frames = fixtureFrames(entry)
    mutateData(frames, 5, (value) => { value.content_block.input = { text: entry.marker } })
    frames.splice(6, 2)
    frames.splice(2, 0, frame("messages", { type: "extension" }))
    expect(() => assertLiveReply(entry, inspectFrames("messages", frames))).not.toThrow()
  })

  test.each([
    ["data after complete", (frames: LiveFrame[]) => { frames.push(frames[0]!) }],
    ["error", (frames: LiveFrame[]) => { frames.unshift(frame("responses", { type: "error" })) }],
    ["response failure", (frames: LiveFrame[]) => { frames.unshift(frame("responses", { type: "response.failed" })) }],
    ["incomplete", (frames: LiveFrame[]) => { frames.unshift(frame("responses", { type: "response.incomplete" })) }],
    ["nested error", (frames: LiveFrame[]) => { mutateData(frames, 0, (value) => { value.error = {} }) }],
    ["header mismatch", (frames: LiveFrame[]) => { frames[0]!.event = "other" }],
    ["duplicate create", (frames: LiveFrame[]) => { frames.splice(1, 0, frames[0]!) }],
    ["missing create", (frames: LiveFrame[]) => { frames.shift() }],
    ["lost text delta", (frames: LiveFrame[]) => { frames.splice(3, 1) }],
  ] as const)("rejects Responses %s", (_name, mutate) => {
    const frames = fixtureFrames(item("responses"))
    mutate(frames)
    expect(() => inspectFrames("responses", frames)).toThrow()
  })

  test("requires Responses call indices, matching deltas and complete tool output", () => {
    const entry = item("responses", true)
    const mutate = [
      (frames: LiveFrame[]) => { frames.splice(3, 0, frames[2]!) },
      (frames: LiveFrame[]) => { frames.splice(2, 1) },
      (frames: LiveFrame[]) => { frames.splice(2, 3) },
      (frames: LiveFrame[]) => { mutateData(frames, 5, (value) => { value.arguments = "{}" }) },
      (frames: LiveFrame[]) => { mutateData(frames, 6, (value) => { value.response.output[0].call_id = "lost-id" }) },
    ]
    for (const change of mutate) {
      const frames = fixtureFrames(entry)
      change(frames)
      expect(() => inspectFrames("responses", frames)).toThrow()
    }
  })
})
