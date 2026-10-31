import { describe, expect, test } from "vitest"
import { markPlaintextAgentArguments, preparePlaintextAgentTasks } from "../../../src/protocols/responses/agent-arguments"

const schema = (name = "spawn_agent", encrypted: unknown = true) => ({
  type: "function", name, parameters: { type: "object", properties: {
    message: { type: "string", description: "Complete task", encrypted },
    other: { type: "string", encrypted: true },
  }, required: ["message"] },
})
const namespace = (tools: unknown = [schema()]) => ({ type: "namespace", name: "collaboration", tools })
const names = preparePlaintextAgentTasks({ input: [], tools: [namespace([schema(), { type: "function", name: "list_agents" }])] }).toolNames
const call = (overrides: Record<string, unknown> = {}) => ({
  type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "fixture-call",
  arguments: JSON.stringify({ message: "Keep the entire task unchanged." }), ...overrides,
})

describe("opt-in Copilot plaintext task parameters", () => {
  test.each(["spawn_agent", "send_message", "followup_task"])("changes only %s message encryption", (name) => {
    const input = [{ type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "opaque-fixture" }] }]
    const request = { model: "raw-model", input, tools: [namespace([schema(name)])] }
    const before = structuredClone(request)
    const result = preparePlaintextAgentTasks(request)
    expect(result.request.tools[0]?.tools).toEqual([schema(name, false)])
    expect(result.request.tools[0]?.name).toBe("raven_agent_compat")
    expect(result.request.input).toBe(input)
    expect(result.toolNames.get(name)).toEqual({ name, flattened: true, encryptedParameters: ["other"] })
    expect(request).toEqual(before)
  })

  test("handles Responses Lite additional_tools without rewriting conversation history", () => {
    const oldMessage = { type: "message", tools: [namespace()], content: "unchanged" }
    const declaration = { type: "additional_tools", id: "tools-fixture", role: "developer", tools: [namespace()] }
    const request = { input: [oldMessage, declaration] }
    const result = preparePlaintextAgentTasks(request)
    expect(result.request.input[0]).toBe(oldMessage)
    expect(result.request.input[1]).toEqual({ ...declaration, tools: [{ ...namespace([schema("spawn_agent", false)]), name: "raven_agent_compat" }] })
    expect(declaration.tools).toEqual([namespace()])
  })

  test.each([null, "bad", {}, { type: "namespace", name: "other", tools: [schema()] }, namespace(null), namespace([
    null, "bad", { type: "custom", name: "spawn_agent" }, schema("unrelated"), { type: "function", name: 5 },
    { type: "function", name: "spawn_agent" }, { type: "function", name: "spawn_agent", parameters: { properties: null } },
    { type: "function", name: "spawn_agent", parameters: { properties: { message: "not-a-schema" } } },
    schema("spawn_agent", false), schema("send_message", "true"),
  ])])("does not change unrelated or invalid tool declarations: %j", (tool) => {
    const request = { input: "hello", tools: [tool] }
    const result = preparePlaintextAgentTasks(request)
    expect(result.request).toBe(request)
    expect(result.toolNames.size).toBe(0)
  })

  test.each([undefined, null, {}, "bad"])("keeps non-array tools untouched: %j", (tools) => {
    const request = { input: [null, { type: "additional_tools", tools }], tools }
    expect(preparePlaintextAgentTasks(request).request).toBe(request)
  })

  test("rewrites only historical tool namespaces, preserving opaque arguments", () => {
    const historical = call({ arguments: '{"message":"opaque-fixture"}', encrypted_function_args: ["message"] })
    const request = { tools: [namespace()], input: [historical, null, { type: "message", content: "untouched" }] }
    const result = preparePlaintextAgentTasks(request)
    expect(result.request.input[0]).toEqual({ ...historical, namespace: "raven_agent_compat" })
    expect(historical.namespace).toBe("collaboration")
  })

  test.each(["tools", "additional_tools"])("does not overwrite an existing wire namespace in %s", (placement) => {
    const collision = { ...namespace(), name: "raven_agent_compat" }
    const request = placement === "tools" ? { tools: [namespace(), collision], input: [] } : { input: [{ type: "additional_tools", tools: [namespace(), collision] }] }
    expect(preparePlaintextAgentTasks(request).request).toBe(request)
  })

  test.each([
    { type: "function", name: "raven_agent_compatspawn_agent" },
    { type: "custom", name: "raven_agent_compatspawn_agent" },
    { type: "namespace", name: "raven_agent_", tools: [{ type: "function", name: "compatspawn_agent" }] },
    { type: "function", name: "collaborationspawn_agent" },
  ])("rejects flattened identity collisions: %j", (collision) => {
    for (const tools of [[namespace(), collision], [collision, namespace()]]) {
      const request = { tools, input: [] }
      expect(preparePlaintextAgentTasks(request).request).toBe(request)
    }
    const request = { tools: [namespace()], input: [{ type: "additional_tools", tools: [collision] }] }
    expect(preparePlaintextAgentTasks(request).request).toBe(request)
  })

  test.each([
    { tools: [namespace(), namespace()] },
    { tools: [namespace([schema(), schema()])] },
    { tools: [namespace([schema(), null])] },
  ])("rejects ambiguous declarations: %j", ({ tools }) => {
    const request = { tools, input: [] }
    expect(preparePlaintextAgentTasks(request).request).toBe(request)
  })

  test("maps only declared historical calls and preserves unrelated prefix names", () => {
    const unrelated = call({ name: "interrupt_agent" })
    const prefix = { type: "function", name: "raven_agent_compatinterrupt_agent" }
    const input = [call({ namespace: undefined, name: "collaborationspawn_agent" }), unrelated]
    const result = preparePlaintextAgentTasks({ input, tools: [namespace(), prefix, null, { type: "namespace", name: 5 }] })
    expect(result.request.input[0]).toMatchObject({ namespace: "raven_agent_compat", name: "spawn_agent" })
    expect(result.request.input[1]).toBe(unrelated)
    expect(result.request.tools[1]).toBe(prefix)
  })

  test.each([true, false])("maps forced and allowed tool references for flattened=%s", (flattened) => {
    const declaration = flattened ? { tools: [namespace()], input: [] } : { input: [{ type: "additional_tools", tools: [namespace()] }] }
    const target = flattened ? { type: "function", name: "raven_agent_compatspawn_agent" } : { type: "function", namespace: "raven_agent_compat", name: "spawn_agent" }
    for (const reference of [{ type: "function", name: "collaborationspawn_agent" }, { type: "function", namespace: "collaboration", name: "spawn_agent" }]) {
      const forced = { ...declaration, tool_choice: reference }
      const before = structuredClone(forced)
      expect(preparePlaintextAgentTasks(forced).request.tool_choice).toEqual(target)
      expect(forced).toEqual(before)
      const allowed = { ...declaration, tool_choice: { type: "allowed_tools", mode: "required", tools: [reference, { type: "function", name: "unrelated" }, null] } }
      expect(preparePlaintextAgentTasks(allowed).request.tool_choice).toEqual({ ...allowed.tool_choice, tools: [target, allowed.tool_choice.tools[1], null] })
    }
    for (const tool_choice of ["auto", { type: "function", name: "unrelated" }, { type: "web_search" }, { type: "allowed_tools", tools: null }]) {
      expect(preparePlaintextAgentTasks({ ...declaration, tool_choice }).request.tool_choice).toBe(tool_choice)
    }
  })
})

describe("explicit function argument encoding metadata", () => {
  test("marks only opted-in calls in JSON and SSE wrappers", () => {
    const original = { response: { output: [call(), { type: "reasoning", encrypted_content: "opaque-fixture" }] } }
    const result = markPlaintextAgentArguments(original, names)
    expect(result).toEqual({ response: { output: [{ ...call(), encrypted_function_args: ["other"] }, original.response.output[1]] } })
    expect(original.response.output[0]).not.toHaveProperty("encrypted_function_args")
    expect(markPlaintextAgentArguments({ item: call() }, names)).toEqual({ item: { ...call(), encrypted_function_args: ["other"] } })
    expect(markPlaintextAgentArguments(call({ name: "collaborationspawn_agent", namespace: undefined }), names))
      .toMatchObject({ encrypted_function_args: ["other"] })
  })

  test.each([undefined, 5, "", "{", "null", "[]"])(
    "does not infer encoding from incomplete or invalid argument objects: %j", (argumentsText) => {
      const input = call({ arguments: argumentsText })
      expect(markPlaintextAgentArguments(input, names)).toBe(input)
    },
  )

  test.each(["{}", '{"message":5}', '{"message":"short"}', JSON.stringify({ message: "a".repeat(100) })])("preserves remaining encrypted fields: %j", (argumentsText) => {
    const input = call({ arguments: argumentsText })
    expect(markPlaintextAgentArguments(input, names)).toEqual({ ...input, encrypted_function_args: ["other"] })
  })

  test.each(["gAAAA", "UlQC"])("retains encryption for recognized opaque %s tasks", (prefix) => {
    const input = call({ arguments: JSON.stringify({ message: `${prefix}${"x".repeat(100)}` }) })
    expect(markPlaintextAgentArguments(input, names)).toEqual({ ...input, encrypted_function_args: ["other", "message"] })
  })

  test.each([[], ["message"], "unknown-metadata"].map((metadata) => ({ metadata })))("preserves explicit upstream metadata: %j", ({ metadata: encrypted_function_args }) => {
    const input = call({ encrypted_function_args })
    expect(markPlaintextAgentArguments(input, names)).toBe(input)
  })

  test.each([null, "data", 5, {}, [], call({ namespace: "other" }), call({ name: 5 }), { type: "custom_tool_call" }].map((input) => ({ input })))(
    "preserves unrelated data: %j", ({ input }) => expect(markPlaintextAgentArguments(input, names)).toBe(input),
  )

  test("no-ops with no opted-in tools and tolerates null encoding metadata", () => {
    const input = call()
    expect(markPlaintextAgentArguments(input, new Map())).toBe(input)
    expect(markPlaintextAgentArguments(call({ encrypted_function_args: null }), names)).toMatchObject({ encrypted_function_args: ["other"] })
  })

  test("restores both aliased and flattened names, including non-message tools", () => {
    for (const name of ["spawn_agent", "list_agents"]) {
      const named = call({ name, namespace: "raven_agent_compat" })
      const flattened = call({ name: `raven_agent_compat${name}`, namespace: undefined })
      for (const input of [named, flattened]) {
        expect(markPlaintextAgentArguments(input, names)).toMatchObject({ name, namespace: "collaboration" })
      }
    }
  })

  test.each([
    call({ name: "raven_agent_compatinterrupt_agent", namespace: undefined }),
    call({ name: "interrupt_agent", namespace: "raven_agent_compat" }),
    call({ name: "raven_agent_compatspawn_agent_extra", namespace: undefined }),
  ])("never restores undeclared prefix-looking identities: %j", (input) => {
    expect(markPlaintextAgentArguments(input, names)).toBe(input)
  })

  test("waits for complete streaming arguments before inferring opaque encoding", () => {
    const state = new Map<string, unknown>()
    const added = { type: "response.output_item.added", output_index: 0, item: call({ arguments: "" }) }
    expect(markPlaintextAgentArguments(added, names, state, added.type)).toBe(added)
    const delta = { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"message":"UlQC' }
    expect(markPlaintextAgentArguments(delta, names, state, delta.type)).toBe(delta)
    const item = call({ arguments: JSON.stringify({ message: `UlQC${"x".repeat(100)}`, other: "opaque-other" }) })
    const done = { type: "response.output_item.done", output_index: 0, item }
    expect(markPlaintextAgentArguments(done, names, state, done.type)).toMatchObject({ item: { encrypted_function_args: ["other", "message"] } })
    const completed = { response: { output: [item] } }
    expect(markPlaintextAgentArguments(completed, names, state, "response.completed")).toMatchObject({ response: { output: [{ encrypted_function_args: ["other", "message"] }] } })
  })

  test.each([[], ["message", "other"], "future-encoding"].map((metadata) => ({ metadata })))("remembers added-only explicit encoding: %j", ({ metadata: encrypted_function_args }) => {
    const state = new Map<string, unknown>()
    const added = { output_index: 1, item: call({ arguments: "", encrypted_function_args }) }
    expect(markPlaintextAgentArguments(added, names, state, "response.output_item.added")).toBe(added)
    const done = { output_index: 1, item: call({ call_id: undefined }) }
    expect(markPlaintextAgentArguments(done, names, state, "response.output_item.done")).toMatchObject({ item: { encrypted_function_args } })
    const completed = { output: [call({ call_id: "another-call" }), call()] }
    expect(markPlaintextAgentArguments(completed, names, state, "response.completed")).toMatchObject({ output: [{ encrypted_function_args: ["other"] }, { encrypted_function_args }] })
  })

  test("tracks call IDs when snapshots change positions and does not share state across responses", () => {
    const state = new Map<string, unknown>()
    markPlaintextAgentArguments({ item: call({ encrypted_function_args: ["message"] }) }, names, state, "response.output_item.added")
    expect(markPlaintextAgentArguments(call(), names, state, "response.output_item.done")).toMatchObject({ encrypted_function_args: ["message"] })
    expect(markPlaintextAgentArguments(call(), names)).toMatchObject({ encrypted_function_args: ["other"] })
    const noKeys = call({ call_id: undefined, encrypted_function_args: [] })
    expect(markPlaintextAgentArguments(noKeys, names, state, "response.output_item.added")).toBe(noKeys)
  })

  test.each(["in_progress", "incomplete", "failed"])("does not infer encoding for %s items even with valid JSON", (status) => {
    const item = call({ status })
    expect(markPlaintextAgentArguments(item, names)).toBe(item)
    expect(markPlaintextAgentArguments({ output: [item] }, names, new Map(), "response.incomplete")).toEqual({ output: [item] })
    const explicit = call({ status, encrypted_function_args: [] })
    expect(markPlaintextAgentArguments(explicit, names)).toBe(explicit)
  })
})
