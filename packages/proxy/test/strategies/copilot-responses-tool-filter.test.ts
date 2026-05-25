/**
 * Regression tests for the Codex CLI <-> Copilot Responses API tool gap.
 *
 * mai-agents reference: litellm_patches/responses/litellm_completion_transformation/handler.py
 *   GithubCopilotResponsesAPIConfig._SUPPORTED_TOOL_TYPES = {"function", "web_search_preview"}
 *
 *   "Codex CLI registers built-in tools like image_generation on every
 *    request, so we must strip them before forwarding to Copilot.
 *    Otherwise: 'The requested tool <type> is not supported.'"
 *
 * Desired: strategy.prepare strips every unsupported tool type, leaves
 * `function` and `web_search_preview` untouched, and flattens Codex MCP
 * `namespace` tools into function tools that Copilot Responses accepts.
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
    userAgent: null,
    anthropicBeta: null,
    sessionId: "sess",
    clientName: "Codex",
    clientVersion: null,
  }
}

const noopClient = { send: async () => ({}) } as unknown as CopilotResponsesClient

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
    // After filtering everything out we must NOT send an empty tools array,
    // since some upstreams interpret "tools: []" as "force no tools".
    // Either omit the key entirely or set it to undefined / null.
    const tools = (out as Record<string, unknown>).tools
    expect(tools == null || (Array.isArray(tools) && tools.length === 0)).toBe(true)
    if (Array.isArray(tools)) expect(tools).toHaveLength(0)
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
    // Caller's array must still hold the original entries.
    expect(tools.map((t) => t.type)).toEqual([
      "image_generation",
      "namespace",
      "function",
    ])
    const namespaceTool = tools[1] as { tools: Array<{ name: string }> }
    expect(namespaceTool.tools[0]!.name).toBe("ListChats")
  })
})
