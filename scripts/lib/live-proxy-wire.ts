import assert from "node:assert/strict"
import type { LiveCase, LiveProtocol } from "./live-proxy-cases"

type Wire = Record<string, unknown>
export interface LiveFrame { event: string | null; data: string }
export interface LiveTool { id: string; name: string; arguments: string }
export interface LiveReply {
  text: string
  tools: LiveTool[]
  terminal: string
  usage: Wire
  model: string
}

export function wireObject(value: unknown): Wire {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object")
  return value as Wire
}

function list(value: unknown): Wire[] {
  assert.ok(Array.isArray(value), "Expected a JSON array")
  return value.map(wireObject)
}

function string(value: unknown): string {
  assert.equal(typeof value, "string", "Expected a string")
  return value as string
}

function tool(value: Wire, protocol: LiveProtocol): LiveTool {
  const fn = protocol === "chat" ? wireObject(value.function) : value
  return {
    id: string(protocol === "responses" ? value.call_id : value.id),
    name: string(fn.name),
    arguments: protocol === "messages" ? JSON.stringify(value.input) : string(fn.arguments),
  }
}

export function inspectJson(protocol: LiveProtocol, raw: unknown, nativeChat = false): LiveReply {
  const value = wireObject(raw)
  assert.ok(!value.error, "Response contains an error")
  assert.ok(string(value.id).length > 0, "Missing response ID")
  const model = string(value.model)
  const usage = wireObject(value.usage)
  if (protocol === "chat") {
    if (!nativeChat || value.object !== undefined) assert.equal(value.object, "chat.completion")
    const choices = list(value.choices)
    assert.equal(choices.length, 1, "Expected one Chat choice")
    const choice = choices[0]!
    const message = wireObject(choice.message)
    assert.equal(message.role, "assistant")
    return { model, usage, text: message.content == null ? "" : string(message.content), tools: list(message.tool_calls ?? []).map((item) => tool(item, protocol)), terminal: string(choice.finish_reason) }
  }
  if (protocol === "messages") {
    assert.equal(value.type, "message")
    assert.equal(value.role, "assistant")
    const content = list(value.content)
    return { model, usage, text: content.filter((item) => item.type === "text").map((item) => string(item.text)).join(""), tools: content.filter((item) => item.type === "tool_use").map((item) => tool(item, protocol)), terminal: string(value.stop_reason) }
  }
  assert.equal(value.object, "response")
  assert.equal(value.status, "completed", "Responses did not complete successfully")
  const output = list(value.output)
  return {
    model, usage, terminal: "completed",
    text: output.filter((item) => item.type === "message").flatMap((item) => {
      assert.equal(item.role, "assistant")
      return list(item.content).filter((part) => part.type === "output_text").map((part) => string(part.text))
    }).join(""),
    tools: output.filter((item) => item.type === "function_call").map((item) => tool(item, protocol)),
  }
}

function inspectChatFrames(frames: readonly LiveFrame[], nativeChat: boolean): LiveReply {
  let text = ""
  let model = ""
  let terminal = ""
  let usage: Wire = {}
  let done = false
  const calls = new Map<number, LiveTool>()
  for (const frame of frames) {
    assert.ok(!done, "Chat data after [DONE]")
    if (frame.data === "[DONE]") {
      assert.ok(terminal, "[DONE] preceded the finish reason")
      done = true
      continue
    }
    const value = wireObject(JSON.parse(frame.data))
    assert.ok(!value.error && frame.event !== "error", "Chat stream error")
    if (!nativeChat || value.object !== undefined) assert.equal(value.object, "chat.completion.chunk")
    assert.ok(string(value.id).length > 0, "Missing chunk ID")
    model = string(value.model)
    if (value.usage != null) usage = wireObject(value.usage)
    for (const choice of list(value.choices)) {
      assert.equal(choice.index, 0)
      const delta = wireObject(choice.delta)
      if (delta.content != null) {
        assert.ok(!terminal, "Text arrived after finish reason")
        text += string(delta.content)
      }
      for (const item of list(delta.tool_calls ?? [])) {
        assert.ok(!terminal, "Tool call arrived after finish reason")
        assert.ok(Number.isInteger(item.index), "Missing tool index")
        const index = item.index as number
        const call = calls.get(index) ?? { id: "", name: "", arguments: "" }
        if (item.id != null) call.id = string(item.id)
        const fn = wireObject(item.function)
        if (fn.name != null) call.name += string(fn.name)
        if (fn.arguments != null) call.arguments += string(fn.arguments)
        calls.set(index, call)
      }
      if (choice.finish_reason != null) {
        assert.ok(!terminal, "Duplicate Chat finish reason")
        terminal = string(choice.finish_reason)
      }
    }
  }
  assert.ok(done, "Missing Chat [DONE]")
  return { model, text, terminal, usage, tools: [...calls.values()] }
}

function inspectMessagesFrames(frames: readonly LiveFrame[]): LiveReply {
  let started = false
  let stopped = false
  let text = ""
  let model = ""
  let terminal = ""
  let usage: Wire = {}
  const blocks = new Map<number, { open: boolean; type: unknown; call?: LiveTool; partial: string }>()
  for (const frame of frames) {
    const value = wireObject(JSON.parse(frame.data))
    assert.ok(!stopped, "Messages data after message_stop")
    assert.ok(value.type !== "error" && !value.error, "Messages stream error")
    assert.equal(frame.event, value.type, "Messages SSE event/type mismatch")
    if (value.type === "ping") continue
    if (value.type === "message_start") {
      assert.ok(!started, "Duplicate message_start")
      const message = wireObject(value.message)
      assert.equal(message.type, "message")
      assert.equal(message.role, "assistant")
      assert.ok(string(message.id).length > 0)
      model = string(message.model)
      usage = wireObject(message.usage)
      started = true
      continue
    }
    assert.ok(started, "Messages event preceded message_start")
    if (value.type === "content_block_start") {
      assert.ok(Number.isInteger(value.index) && !blocks.has(value.index as number), "Invalid or duplicate block index")
      const block = wireObject(value.content_block)
      if (block.type === "text") text += string(block.text)
      blocks.set(value.index as number, { open: true, type: block.type, partial: "", ...(block.type === "tool_use" ? { call: tool(block, "messages") } : {}) })
    } else if (value.type === "content_block_delta" || value.type === "content_block_stop") {
      const block = blocks.get(value.index as number)
      assert.ok(block?.open, "Delta/stop without an open content block")
      if (value.type === "content_block_stop") {
        block.open = false
        if (block.call && block.partial) block.call.arguments = block.partial
      } else {
        const delta = wireObject(value.delta)
        if (delta.type === "text_delta") {
          assert.equal(block.type, "text")
          text += string(delta.text)
        } else if (delta.type === "input_json_delta") {
          assert.equal(block.type, "tool_use")
          block.partial += string(delta.partial_json)
        }
      }
    } else if (value.type === "message_delta") {
      assert.ok([...blocks.values()].every((block) => !block.open), "message_delta preceded block closure")
      const delta = wireObject(value.delta)
      if (delta.stop_reason != null) terminal = string(delta.stop_reason)
      if (value.usage != null) usage = { ...usage, ...wireObject(value.usage) }
    } else if (value.type === "message_stop") {
      assert.ok(terminal && [...blocks.values()].every((block) => !block.open), "Premature message_stop")
      stopped = true
    }
  }
  assert.ok(stopped, "Missing message_stop")
  return { model, text, terminal, usage, tools: [...blocks.values()].flatMap((block) => block.call ? [block.call] : []) }
}

function inspectResponsesFrames(frames: readonly LiveFrame[]): LiveReply {
  let started = false
  let text = ""
  let result: LiveReply | undefined
  const calls = new Map<number, LiveTool>()
  for (const frame of frames) {
    const value = wireObject(JSON.parse(frame.data))
    assert.ok(!result, "Responses data after response.completed")
    assert.ok(!value.error && !["error", "response.failed", "response.incomplete"].includes(String(value.type)), "Responses stream error or incomplete response")
    assert.equal(frame.event, value.type, "Responses SSE event/type mismatch")
    if (value.type === "response.created") {
      assert.ok(!started, "Duplicate response.created")
      assert.ok(string(wireObject(value.response).id).length > 0)
      started = true
      continue
    }
    assert.ok(started, "Responses event preceded response.created")
    if (value.type === "response.output_text.delta") text += string(value.delta)
    if (value.type === "response.output_item.added") {
      const item = wireObject(value.item)
      if (item.type === "function_call") {
        assert.ok(Number.isInteger(value.output_index) && !calls.has(value.output_index as number), "Invalid or duplicate output index")
        calls.set(value.output_index as number, tool(item, "responses"))
      }
    }
    if (value.type === "response.function_call_arguments.delta") {
      const call = calls.get(value.output_index as number)
      assert.ok(call, "Tool delta preceded output_item.added")
      call.arguments += string(value.delta)
    }
    if (value.type === "response.function_call_arguments.done") {
      const call = calls.get(value.output_index as number)
      assert.ok(call, "Tool completion preceded output_item.added")
      assert.equal(call.arguments, value.arguments, "Tool deltas differ from completed arguments")
    }
    if (value.type === "response.completed") {
      result = inspectJson("responses", value.response)
      assert.equal(text, result.text, "Text deltas differ from completed response")
      assert.deepEqual([...calls.values()], result.tools, "Tool deltas differ from completed response")
    }
  }
  assert.ok(result, "Missing response.completed")
  return result
}

export function inspectFrames(protocol: LiveProtocol, frames: readonly LiveFrame[], nativeChat = false): LiveReply {
  assert.ok(frames.length > 0, "Empty SSE response")
  return protocol === "chat" ? inspectChatFrames(frames, nativeChat) : protocol === "messages" ? inspectMessagesFrames(frames) : inspectResponsesFrames(frames)
}

export function assertLiveReply(item: LiveCase, reply: LiveReply): void {
  const input = reply.usage[item.protocol === "chat" ? "prompt_tokens" : "input_tokens"]
  const output = reply.usage[item.protocol === "chat" ? "completion_tokens" : "output_tokens"]
  if (requiresLiveUsage(item) || Object.keys(reply.usage).length) {
    assert.ok(typeof input === "number" && Number.isFinite(input) && input >= 0, "Missing/invalid input usage")
    assert.ok(typeof output === "number" && Number.isFinite(output) && output >= 0, "Missing/invalid output usage")
  }
  const terminal = item.protocol === "responses" ? "completed" : item.protocol === "messages"
    ? item.kind === "tool" ? "tool_use" : "end_turn"
    : item.kind === "tool" ? "tool_calls" : "stop"
  assert.equal(reply.terminal, terminal, "Unexpected terminal reason")
  if (item.kind === "tool") {
    assert.equal(reply.tools.length, 1, "Expected exactly one tool call")
    const call = reply.tools[0]!
    assert.ok(call.id.length > 0, "Missing tool call ID")
    assert.equal(call.name, "echo")
    assert.deepEqual(JSON.parse(call.arguments), { text: item.marker }, "Tool arguments changed")
  } else {
    assert.equal(reply.tools.length, 0, "Unexpected tool call")
    assert.ok(reply.text.includes(item.marker), "Reply did not preserve the requested marker")
  }
}

export function requiresLiveUsage(item: LiveCase): boolean {
  return !item.stream || item.upstreamFormat !== "openai" || item.protocol === "chat"
}
