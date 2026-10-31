/**
 * Codex CLI <-> Copilot Responses API tool compatibility tests.
 */
import { describe, expect, test } from "vitest"

import { makeCopilotResponses } from "../../src/strategies/copilot-responses"
import type { RequestContext } from "../../src/core/context"
import type {
  CopilotResponsesClient,
  ResponsesPayload,
} from "../../src/upstream/copilot-responses"

function makeCtx(): RequestContext {
  return {
    requestId: "01TESTRESPONSESCOMPAT0000",
    startTime: performance.now(),
    format: "responses",
    path: "/v1/responses",
    stream: false,
    accountName: "acct",
    keyId: "key-acct",
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Codex",
    clientVersion: null,
  }
}

const noopClient = { send: async () => ({}) } as unknown as CopilotResponsesClient

describe("opt-in native collaboration task compatibility", () => {
  const declaration = () => ({ type: "namespace", name: "collaboration", tools: [{
    type: "function", name: "spawn_agent", parameters: { type: "object", properties: { message: { type: "string", encrypted: true } } },
  }] })
  const responseItem = { type: "function_call", id: "fc-fixture", name: "collaborationspawn_agent", call_id: "call-fixture", arguments: '{"message":"Complete task text"}' }

  test("defaults off", () => {
    const strategy = makeCopilotResponses({ client: noopClient })
    const prepared = strategy.prepare({ model: "gpt-6-astra", input: "hello", tools: [declaration()] }, makeCtx())
    expect(asTools(prepared)[0]).toMatchObject({ parameters: { properties: { message: { encrypted: true } } } })
    const result = strategy.adaptJson({ output: [responseItem] }, prepared, makeCtx()) as { output: unknown[] }
    expect(result.output[0]).not.toHaveProperty("encrypted_function_args")
  })

  test("tracks flattened tools and marks returned JSON calls", () => {
    const strategy = makeCopilotResponses({ client: noopClient, plaintextAgentTasks: true })
    const prepared = strategy.prepare({ model: "gpt-6-astra", input: "hello", tools: [declaration()] }, makeCtx())
    expect(asTools(prepared)[0]).toMatchObject({ parameters: { properties: { message: { encrypted: false } } } })
    expect(strategy.adaptJson({ output: [{ ...responseItem, name: "raven_agent_compatspawn_agent" }] }, prepared, makeCtx())).toMatchObject({ output: [{
      namespace: "collaboration", name: "spawn_agent", encrypted_function_args: [], call_id: "call-fixture",
    }] })
  })

  test.each([false, true])("keeps explicitly namespaced Lite calls out of flattened aliases (enabled=%s)", async (enabled) => {
    const strategy = makeCopilotResponses({ client: noopClient, plaintextAgentTasks: enabled })
    const flatName = `${enabled ? "raven_agent_compat" : "collaboration"}spawn_agent`
    const request = { model: "raw-model", tools: [declaration()], input: [{ type: "additional_tools", tools: [{
      type: "namespace", name: "unrelated", tools: [{ type: "function", name: flatName, parameters: {} }],
    }] }] }
    const prepared = strategy.prepare(request, makeCtx())
    const unrelated = { ...responseItem, name: flatName, namespace: "unrelated" }
    expect(strategy.adaptJson({ output: [unrelated] }, prepared, makeCtx())).toEqual({ output: [unrelated] })
    const state = strategy.initStreamState(prepared, makeCtx())
    for (const payload of [
      { type: "response.output_item.added", output_index: 0, item: { ...unrelated, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item: unrelated },
      { type: "response.completed", response: { output: [unrelated] } },
    ]) {
      const result = strategy.adaptChunk({ event: payload.type, data: JSON.stringify(payload), id: null, retry: null }, state, makeCtx())
      expect(JSON.parse(await result[0]!.data)).toEqual(payload)
    }
    // A matching explicit owner still resolves to the declared native identity.
    expect(strategy.adaptJson({ output: [{ ...responseItem, name: flatName, namespace: enabled ? "raven_agent_compat" : "collaboration" }] }, prepared, makeCtx()))
      .toMatchObject({ output: [{ namespace: "collaboration", name: "spawn_agent" }] })
  })

  test.each(["response.completed", "response.done", "response.incomplete", "response.failed"])("keeps completed call encoding in %s", async (event) => {
    const strategy = makeCopilotResponses({ client: noopClient, plaintextAgentTasks: true })
    const prepared = strategy.prepare({ model: "raw-model", input: [], tools: [declaration()] }, makeCtx())
    const state = strategy.initStreamState(prepared, makeCtx())
    const item = { ...responseItem, name: "raven_agent_compatspawn_agent", status: "completed" }
    const done = strategy.adaptChunk({ event: "response.output_item.done", data: JSON.stringify({ output_index: 0, item }), id: null, retry: null }, state, makeCtx())
    expect(JSON.parse(await done[0]!.data).item.encrypted_function_args).toEqual([])
    const payload = { type: event, response: { output: [item] } }
    const result = strategy.adaptChunk({ event, data: JSON.stringify(payload), id: null, retry: null }, state, makeCtx())
    expect(JSON.parse(await result[0]!.data)).toEqual({ ...payload, response: { output: [{ ...item, name: "spawn_agent", namespace: "collaboration", encrypted_function_args: [] }] } })
    expect(strategy.streamOutcome?.(state)).toBe(event === "response.failed" ? "error" : "success")
  })

  test("marks Lite streaming items and terminal snapshots but not text or errors", async () => {
    const strategy = makeCopilotResponses({ client: noopClient, plaintextAgentTasks: true })
    const request = { model: "gpt-6-astra", input: [{ type: "additional_tools", tools: [declaration()] }] }
    const prepared = strategy.prepare(request, makeCtx())
    const state = strategy.initStreamState(prepared, makeCtx())
    const item = { ...responseItem, namespace: "raven_agent_compat", name: "spawn_agent" }
    for (const event of ["response.output_item.added", "response.output_item.done", "response.completed"]) {
      const parsed = event === "response.completed" ? { type: event, response: { output: [item] } } : { type: event, output_index: 0, item: event === "response.output_item.added" ? { ...item, arguments: "" } : item }
      const result = strategy.adaptChunk({ event, data: JSON.stringify(parsed), id: "sse-id", retry: null }, state, makeCtx())
      const output = JSON.parse(await result[0]!.data)
      const outputItem = event === "response.completed" ? output.response.output[0] : output.item
      expect(outputItem).toMatchObject({ namespace: "collaboration", name: "spawn_agent", call_id: "call-fixture" })
      if (event === "response.output_item.added") expect(outputItem).not.toHaveProperty("encrypted_function_args")
      else expect(outputItem.encrypted_function_args).toEqual([])
      expect(result[0]!.id).toBe("sse-id")
    }
    const data = '{"type":"response.output_text.delta","delta":"unchanged"}'
    expect(strategy.adaptChunk({ event: "response.output_text.delta", data, id: null, retry: null }, state, makeCtx())[0]!.data).toBe(data)
    expect(strategy.adaptChunk({ event: "response.failed", data: '{"type":"response.failed"}', id: null, retry: null }, state, makeCtx())[0]!.data).toBe('{"type":"response.failed"}')
    expect(strategy.prepare({ model: "raw-model", input: "no tools" }, makeCtx())).toEqual({ model: "raw-model", input: "no tools" })
  })

  test("forced and allowed choices resolve to the actual flattened declaration", () => {
    const strategy = makeCopilotResponses({ client: noopClient, plaintextAgentTasks: true })
    for (const choice of [{ type: "function", name: "collaborationspawn_agent" }, { type: "function", namespace: "collaboration", name: "spawn_agent" }]) {
      const request = { model: "raw-model", input: [], tools: [declaration()], tool_choice: choice }
      const before = structuredClone(request)
      const prepared = strategy.prepare(request, makeCtx())
      expect(prepared.tool_choice).toEqual({ type: "function", name: asTools(prepared)[0]?.name })
      const allowed = strategy.prepare({ ...request, tool_choice: { type: "allowed_tools", mode: "required", tools: [choice] } }, makeCtx())
      expect(allowed.tool_choice).toMatchObject({ tools: [{ type: "function", name: asTools(allowed)[0]?.name }] })
      expect(request).toEqual(before)
    }
  })

  test.each([true, false])("preserves streaming explicit/opaque encoding and other encrypted fields (explicit=%s)", async (explicit) => {
    const strategy = makeCopilotResponses({ client: noopClient, plaintextAgentTasks: true })
    const tool = declaration()
    const child = tool.tools[0]!
    const prepared = strategy.prepare({ model: "raw-model", input: [], tools: [{ ...tool, tools: [{ ...child,
      parameters: { ...child.parameters, properties: { ...child.parameters.properties, other: { encrypted: true } } },
    }] }] }, makeCtx())
    const state = strategy.initStreamState(prepared, makeCtx())
    const item = { ...responseItem, name: "raven_agent_compatspawn_agent", arguments: JSON.stringify({ message: `UlQC${"x".repeat(100)}` }) }
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", ...(explicit ? { encrypted_function_args: ["other"] } : {}) } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { output: [item] } },
    ]
    for (const payload of events) {
      const result = strategy.adaptChunk({ event: payload.type, data: JSON.stringify(payload), id: null, retry: null }, state, makeCtx())
      const parsed = JSON.parse(await result[0]!.data)
      if (payload.type.endsWith("delta")) expect(parsed).toEqual(payload)
      else {
        const output = payload.type === "response.completed" ? parsed.response.output[0] : parsed.item
        expect(output).toMatchObject({ namespace: "collaboration", name: "spawn_agent" })
        if (payload.type.endsWith("added") && !explicit) expect(output).not.toHaveProperty("encrypted_function_args")
        else expect(output.encrypted_function_args).toEqual(explicit ? ["other"] : ["other", "message"])
      }
    }
  })
})

function asTools(prepared: ResponsesPayload): Array<Record<string, unknown>> {
  const tools = (prepared as Record<string, unknown>).tools
  if (tools == null) return []
  if (!Array.isArray(tools)) throw new Error("tools must be an array (or null)")
  return tools as Array<Record<string, unknown>>
}

describe("Gap 3: Codex Responses tool type filtering", () => {
  test("strips image_generation tools that Copilot rejects", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools: [
        { type: "image_generation" },
        { type: "function", name: "shell", parameters: {} },
      ],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const tools = asTools(out)

    expect(tools.map((t) => t.type)).toEqual(["function"])
  })

  test("strips multiple unsupported tool types in one request", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools: [
        { type: "image_generation" },
        { type: "code_interpreter" },
        { type: "file_search" },
        { type: "mcp" },
        { type: "computer_use_preview" },
        { type: "local_shell" },
        { type: "function", name: "shell", parameters: {} },
        { type: "web_search_preview" },
      ],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const tools = asTools(out)
    const types = tools.map((t) => t.type).sort()
    expect(types).toEqual(["function", "web_search_preview"])
  })

  test("flattens namespace tools into function tools", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "mcp__teams__",
          description: "Teams MCP tools",
          tools: [
            {
              type: "function",
              name: "ListChats",
              description: "List chats",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const tools = asTools(out)

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      type: "function",
      name: "mcp__teams__ListChats",
      description: "List chats",
      parameters: { type: "object", properties: {} },
    })
  })

  test("restores flattened namespace function calls in JSON responses", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "mcp__workiq__",
          tools: [{ type: "function", name: "ask_work_iq", parameters: {} }],
        },
      ],
    } as unknown as ResponsesPayload
    const prepared = s.prepare(req, makeCtx())
    const resp = {
      id: "resp_1",
      output: [
        {
          type: "function_call",
          name: "mcp__workiq__ask_work_iq",
          arguments: "{}",
          call_id: "call_1",
        },
      ],
    }

    const out = s.adaptJson(resp, prepared, makeCtx()) as typeof resp

    expect(out.output[0]).toMatchObject({
      type: "function_call",
      namespace: "mcp__workiq__",
      name: "ask_work_iq",
      call_id: "call_1",
    })
    expect(resp.output[0]!.name).toBe("mcp__workiq__ask_work_iq")
  })

  test("drops gpt-5 sampling and still restores namespace tools", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      temperature: 0.7,
      top_p: 0.9,
      tools: [
        {
          type: "namespace",
          name: "mcp__workiq__",
          tools: [{ type: "function", name: "ask_work_iq", parameters: {} }],
        },
      ],
    } as unknown as ResponsesPayload
    const prepared = s.prepare(req, makeCtx())
    expect(prepared).not.toBe(req)
    expect(prepared.temperature).toBeUndefined()
    expect(prepared.top_p).toBeUndefined()
    expect(asTools(prepared)[0]).toMatchObject({ name: "mcp__workiq__ask_work_iq" })

    const resp = {
      output: [
        {
          type: "function_call",
          name: "mcp__workiq__ask_work_iq",
          arguments: "{}",
          call_id: "call_1",
        },
      ],
    }
    const out = s.adaptJson(resp, prepared, makeCtx()) as typeof resp
    expect(out.output[0]).toMatchObject({
      namespace: "mcp__workiq__",
      name: "ask_work_iq",
    })
  })

  test("restores flattened namespace function calls in stream chunks", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      stream: true,
      tools: [
        {
          type: "namespace",
          name: "mcp__teams__",
          tools: [{ type: "function", name: "ListChats", parameters: {} }],
        },
      ],
    } as unknown as ResponsesPayload
    const prepared = s.prepare(req, makeCtx())
    const state = s.initStreamState(prepared, makeCtx())
    const out = s.adaptChunk(
      {
        event: "response.output_item.done",
        data: JSON.stringify({
          item: {
            type: "function_call",
            name: "mcp__teams__ListChats",
            arguments: "{}",
            call_id: "call_2",
          },
        }),
        id: null,
        retry: null,
      },
      state,
      makeCtx(),
    )

    const parsed = JSON.parse(String(out[0]!.data))
    expect(parsed.item).toMatchObject({
      type: "function_call",
      namespace: "mcp__teams__",
      name: "ListChats",
      call_id: "call_2",
    })
  })

  test("flattens namespaced function_call history in request input", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const functionCall = {
      type: "function_call",
      namespace: "mcp__teams__",
      name: "ListChats",
      arguments: "{}",
      call_id: "call_3",
    }
    const input = [
      { role: "user", content: "show my chats" },
      functionCall,
      { type: "function_call_output", call_id: "call_3", output: "[]" },
    ]
    const req = {
      model: "gpt-5.5",
      input,
      tools: [
        {
          type: "namespace",
          name: "mcp__teams__",
          tools: [{ type: "function", name: "ListChats", parameters: {} }],
        },
      ],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const outInput = (out as Record<string, unknown>).input as Array<Record<string, unknown>>

    expect(outInput).not.toBe(input)
    expect(outInput[1]).toMatchObject({
      type: "function_call",
      name: "mcp__teams__ListChats",
      arguments: "{}",
      call_id: "call_3",
    })
    expect(outInput[1]).not.toHaveProperty("namespace")
    expect(functionCall).toMatchObject({
      namespace: "mcp__teams__",
      name: "ListChats",
    })
  })

  test("flattens namespaced function_call history without current tool definitions", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const functionCall = {
      type: "function_call",
      namespace: "mcp__workiq__",
      name: "ask_work_iq",
      arguments: "{}",
      call_id: "call_4",
    }
    const req = {
      model: "gpt-5.5",
      input: [functionCall],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const outInput = (out as Record<string, unknown>).input as Array<Record<string, unknown>>

    expect(outInput[0]).toMatchObject({
      type: "function_call",
      name: "mcp__workiq__ask_work_iq",
      call_id: "call_4",
    })
    expect(outInput[0]).not.toHaveProperty("namespace")
    expect(functionCall.name).toBe("ask_work_iq")
    expect(functionCall.namespace).toBe("mcp__workiq__")
  })

  test("preserves function tool definitions untouched", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const fn = {
      type: "function",
      name: "shell",
      description: "run shell",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    }
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools: [fn],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const tools = asTools(out)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual(fn)
  })

  test("preserves web_search_preview tools (Copilot supports them)", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools: [{ type: "web_search_preview" }],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const tools = asTools(out)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe("web_search_preview")
  })

  test("when all tools are unsupported, tools field is removed (not left empty)", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools: [{ type: "image_generation" }, { type: "code_interpreter" }],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    expect("tools" in (out as Record<string, unknown>)).toBe(false)
  })

  test("requests without a tools field are passed through unchanged", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = { model: "gpt-5.5", input: "hi" } as unknown as ResponsesPayload
    const out = s.prepare(req, makeCtx())
    expect((out as Record<string, unknown>).tools).toBeUndefined()
  })

  test("prepare does not mutate the caller's payload", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const tools = [
      { type: "image_generation" },
      {
        type: "namespace",
        name: "mcp__teams__",
        tools: [{ type: "function", name: "ListChats", parameters: {} }],
      },
      { type: "function", name: "shell", parameters: {} },
    ]
    const req = {
      model: "gpt-5.5",
      input: "hi",
      tools,
    } as unknown as ResponsesPayload

    s.prepare(req, makeCtx())
    expect(tools.map((t) => t.type)).toEqual([
      "image_generation",
      "namespace",
      "function",
    ])
    const namespaceTool = tools[1] as { tools: Array<{ name: string }> }
    expect(namespaceTool.tools[0]!.name).toBe("ListChats")
  })

  test("deeply nested input does not cause stack overflow", () => {
    const s = makeCopilotResponses({ client: noopClient })
    let deep: Record<string, unknown> = {
      type: "function_call",
      namespace: "mcp__teams__",
      name: "ListChats",
      arguments: "{}",
      call_id: "deep",
    }
    for (let i = 0; i < 50; i++) {
      deep = { nested: deep }
    }
    const req = {
      model: "gpt-5.5",
      input: [deep],
      tools: [
        {
          type: "namespace",
          name: "mcp__teams__",
          tools: [{ type: "function", name: "ListChats", parameters: {} }],
        },
      ],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    expect(out).toBeDefined()
  })

  test("flattens function_call nested inside a wrapper object in input", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: [
        {
          wrapper: {
            type: "function_call",
            namespace: "mcp__teams__",
            name: "ListChats",
            arguments: "{}",
            call_id: "call_nested",
          },
        },
      ],
      tools: [
        {
          type: "namespace",
          name: "mcp__teams__",
          tools: [{ type: "function", name: "ListChats", parameters: {} }],
        },
      ],
    } as unknown as ResponsesPayload

    const out = s.prepare(req, makeCtx())
    const outInput = (out as Record<string, unknown>).input as Array<Record<string, unknown>>
    const wrapper = outInput[0] as { wrapper: Record<string, unknown> }
    expect(wrapper.wrapper).toMatchObject({
      type: "function_call",
      name: "mcp__teams__ListChats",
    })
    expect(wrapper.wrapper).not.toHaveProperty("namespace")
  })

  test("restores namespace in stream chunk with invalid JSON gracefully", () => {
    const s = makeCopilotResponses({ client: noopClient })
    const req = {
      model: "gpt-5.5",
      input: "hi",
      stream: true,
      tools: [
        {
          type: "namespace",
          name: "mcp__teams__",
          tools: [{ type: "function", name: "ListChats", parameters: {} }],
        },
      ],
    } as unknown as ResponsesPayload
    const prepared = s.prepare(req, makeCtx())
    const state = s.initStreamState(prepared, makeCtx())
    const out = s.adaptChunk(
      { event: "response.text.delta", data: "not valid json{{{", id: null, retry: null },
      state,
      makeCtx(),
    )
    expect(String(out[0]!.data)).toBe("not valid json{{{")
  })
})
