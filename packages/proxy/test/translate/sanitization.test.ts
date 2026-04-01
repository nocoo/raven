import { describe, expect, test } from "bun:test"
import {
  UNSUPPORTED_CONTENT_TYPES,
  BLOCK_METADATA_TO_STRIP,
  TOOL_USE_FIELDS_TO_STRIP,
  TOOL_SCHEMA_FIELDS_TO_STRIP,
  filterContentBlocks,
  stripBlockMetadata,
  stripToolUseFields,
  sanitizeToolDefinitions,
} from "../../src/routes/messages/non-stream-translation"
import { translateToOpenAI } from "../../src/routes/messages/non-stream-translation"
import type { AnthropicMessagesPayload, AnthropicTool, AnthropicToolUseBlock } from "../../src/routes/messages/anthropic-types"

// ===========================================================================
// Content Block Filtering Tests
// ===========================================================================

describe("filterContentBlocks", () => {
  test("filters server_tool_use blocks", () => {
    const blocks = [
      { type: "text", text: "Hello" },
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
      { type: "text", text: "World" },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(2)
    expect(result.every(b => b.type === "text")).toBe(true)
  })

  test("filters web_search_tool_result blocks", () => {
    const blocks = [
      { type: "text", text: "Search results:" },
      { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("text")
  })

  test("filters all unsupported content types", () => {
    // Test each unsupported type individually
    for (const unsupportedType of UNSUPPORTED_CONTENT_TYPES) {
      const blocks = [
        { type: "text", text: "Keep me" },
        { type: unsupportedType, id: "test", content: "test" },
      ]
      const result = filterContentBlocks(blocks)
      expect(result).toHaveLength(1)
      expect(result[0]!.type).toBe("text")
    }
  })

  test("preserves supported content types", () => {
    const blocks = [
      { type: "text", text: "Hello" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
      { type: "tool_use", id: "tu_1", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "tu_1", content: "result" },
      { type: "thinking", thinking: "hmm..." },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(5)
  })

  test("handles empty array", () => {
    const result = filterContentBlocks([])
    expect(result).toHaveLength(0)
  })

  test("handles array with all unsupported types", () => {
    const blocks = [
      { type: "mcp_tool_use", id: "mcp_1" },
      { type: "mcp_tool_result", tool_use_id: "mcp_1" },
      { type: "tool_reference", tool_name: "some_tool" },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(0)
  })

  test("filters redacted_thinking but preserves thinking", () => {
    const blocks = [
      { type: "thinking", thinking: "Let me think..." },
      { type: "redacted_thinking", data: "opaque" },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("thinking")
  })

  test("filters MCP-related blocks", () => {
    const blocks = [
      { type: "mcp_tool_use", id: "mcp_1", name: "mcp_tool", input: {} },
      { type: "mcp_tool_result", tool_use_id: "mcp_1", content: "result" },
      { type: "text", text: "Keep" },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("text")
  })

  test("filters code execution result blocks", () => {
    const blocks = [
      { type: "code_execution_tool_result", content: "output" },
      { type: "bash_code_execution_tool_result", content: "bash output" },
      { type: "text_editor_code_execution_tool_result", content: "editor output" },
      { type: "text", text: "Keep" },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("text")
  })

  test("filters container and connector blocks", () => {
    const blocks = [
      { type: "container_upload", content: "upload" },
      { type: "connector_text", content: "connector" },
      { type: "text", text: "Keep" },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("text")
  })

  test("filters search and citation blocks", () => {
    const blocks = [
      { type: "search_result", content: "search" },
      { type: "citations", content: [] },
      { type: "citation", content: "cite" },
      { type: "text", text: "Keep" },
    ]
    const result = filterContentBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("text")
  })
})

// ===========================================================================
// Block Metadata Stripping Tests
// ===========================================================================

describe("stripBlockMetadata", () => {
  test("strips cache_control from block", () => {
    const block = {
      type: "text",
      text: "Hello",
      cache_control: { type: "ephemeral" },
    }
    stripBlockMetadata(block)
    expect(block).not.toHaveProperty("cache_control")
    expect(block.text).toBe("Hello")
  })

  test("strips citations from block", () => {
    const block = {
      type: "text",
      text: "Hello",
      citations: [{ url: "http://example.com" }],
    }
    stripBlockMetadata(block)
    expect(block).not.toHaveProperty("citations")
    expect(block.text).toBe("Hello")
  })

  test("strips multiple metadata fields", () => {
    const block = {
      type: "text",
      text: "Hello",
      cache_control: { type: "ephemeral" },
      citations: [],
    }
    stripBlockMetadata(block)
    expect(block).not.toHaveProperty("cache_control")
    expect(block).not.toHaveProperty("citations")
  })

  test("preserves standard fields", () => {
    const block = {
      type: "text",
      text: "Hello",
    }
    stripBlockMetadata(block)
    expect(block.type).toBe("text")
    expect(block.text).toBe("Hello")
  })

  test("handles block without metadata fields", () => {
    const block = {
      type: "tool_use",
      id: "tu_1",
      name: "read",
      input: { path: "/file" },
    }
    stripBlockMetadata(block)
    expect(block.id).toBe("tu_1")
    expect(block.name).toBe("read")
  })
})

// ===========================================================================
// Tool Use Field Stripping Tests
// ===========================================================================

describe("stripToolUseFields", () => {
  test("strips caller field from tool_use", () => {
    const block = {
      type: "tool_use",
      id: "tu_1",
      name: "read",
      input: { path: "/file" },
      caller: "tool_search_agent",
    } as AnthropicToolUseBlock & { caller: string }

    stripToolUseFields(block)
    expect(block).not.toHaveProperty("caller")
    expect(block.id).toBe("tu_1")
    expect(block.name).toBe("read")
  })

  test("preserves standard tool_use fields", () => {
    const block: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "tu_1",
      name: "write",
      input: { path: "/file", content: "hello" },
    }
    stripToolUseFields(block)
    expect(block.type).toBe("tool_use")
    expect(block.id).toBe("tu_1")
    expect(block.name).toBe("write")
    expect(block.input).toEqual({ path: "/file", content: "hello" })
  })

  test("handles tool_use without extended fields", () => {
    const block: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "tu_1",
      name: "bash",
      input: { command: "ls" },
    }
    // Should not throw
    stripToolUseFields(block)
    expect(block.id).toBe("tu_1")
  })
})

// ===========================================================================
// Tool Schema Sanitization Tests
// ===========================================================================

describe("sanitizeToolDefinitions", () => {
  test("strips cache_control from tool schema", () => {
    const tools: (AnthropicTool & { cache_control?: unknown })[] = [
      {
        name: "read",
        description: "Read a file",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ]
    sanitizeToolDefinitions(tools)
    expect(tools[0]).not.toHaveProperty("cache_control")
    expect(tools[0]!.name).toBe("read")
  })

  test("strips defer_loading from tool schema", () => {
    const tools: (AnthropicTool & { defer_loading?: boolean })[] = [
      {
        name: "search",
        description: "Search",
        input_schema: { type: "object" },
        defer_loading: true,
      },
    ]
    sanitizeToolDefinitions(tools)
    expect(tools[0]).not.toHaveProperty("defer_loading")
  })

  test("strips strict from tool schema", () => {
    const tools: (AnthropicTool & { strict?: boolean })[] = [
      {
        name: "write",
        description: "Write",
        input_schema: { type: "object" },
        strict: true,
      },
    ]
    sanitizeToolDefinitions(tools)
    expect(tools[0]).not.toHaveProperty("strict")
  })

  test("strips eager_input_streaming from tool schema", () => {
    const tools: (AnthropicTool & { eager_input_streaming?: boolean })[] = [
      {
        name: "edit",
        description: "Edit",
        input_schema: { type: "object" },
        eager_input_streaming: true,
      },
    ]
    sanitizeToolDefinitions(tools)
    expect(tools[0]).not.toHaveProperty("eager_input_streaming")
  })

  test("strips all extended fields at once", () => {
    const tools: (AnthropicTool & Record<string, unknown>)[] = [
      {
        name: "tool",
        description: "Tool",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
        defer_loading: true,
        strict: true,
        eager_input_streaming: true,
      },
    ]
    sanitizeToolDefinitions(tools)
    for (const field of TOOL_SCHEMA_FIELDS_TO_STRIP) {
      expect(tools[0]).not.toHaveProperty(field)
    }
  })

  test("preserves standard tool fields", () => {
    const tools: AnthropicTool[] = [
      {
        name: "bash",
        description: "Run bash command",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
        type: "custom",
      },
    ]
    sanitizeToolDefinitions(tools)
    expect(tools[0]!.name).toBe("bash")
    expect(tools[0]!.description).toBe("Run bash command")
    expect(tools[0]!.input_schema).toEqual({ type: "object", properties: { command: { type: "string" } } })
    expect(tools[0]!.type).toBe("custom")
  })

  test("preserves server-side tool type field", () => {
    const tools: AnthropicTool[] = [
      {
        name: "web_search",
        description: "Search the web",
        input_schema: { type: "object" },
        type: "web_search_20260209",
      },
    ]
    sanitizeToolDefinitions(tools)
    expect(tools[0]!.type).toBe("web_search_20260209")
  })

  test("handles multiple tools", () => {
    const tools: (AnthropicTool & { cache_control?: unknown })[] = [
      { name: "read", description: "Read", input_schema: {}, cache_control: {} },
      { name: "write", description: "Write", input_schema: {}, cache_control: {} },
      { name: "edit", description: "Edit", input_schema: {} },
    ]
    sanitizeToolDefinitions(tools)
    expect(tools[0]).not.toHaveProperty("cache_control")
    expect(tools[1]).not.toHaveProperty("cache_control")
    expect(tools[2]!.name).toBe("edit")
  })
})

// ===========================================================================
// Integration: translateToOpenAI with sanitization
// ===========================================================================

describe("translateToOpenAI with sanitization", () => {
  test("filters unsupported content blocks in user messages", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "mcp_tool_use", id: "mcp_1", name: "mcp_tool", input: {} } as any,
          ],
        },
      ],
      system: null,
      metadata: null,
      stop_sequences: null,
      stream: false,
      temperature: null,
      top_p: null,
      top_k: null,
      tools: null,
      tool_choice: null,
      thinking: null,
      service_tier: null,
    }
    const result = translateToOpenAI(payload)
    // User message should only have "Hello" text
    const userMsg = result.messages.find(m => m.role === "user")
    expect(userMsg?.content).toBe("Hello")
  })

  test("filters unsupported content blocks in assistant messages", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi there" },
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } as any,
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] } as any,
          ],
        },
      ],
      system: null,
      metadata: null,
      stop_sequences: null,
      stream: false,
      temperature: null,
      top_p: null,
      top_k: null,
      tools: null,
      tool_choice: null,
      thinking: null,
      service_tier: null,
    }
    const result = translateToOpenAI(payload)
    const assistantMsg = result.messages.find(m => m.role === "assistant")
    // Should only contain the text content
    expect(assistantMsg?.content).toBe("Hi there")
    expect(assistantMsg?.tool_calls).toBeNull()
  })

  test("drops assistant message entirely when all content is filtered", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            // All Anthropic-only blocks that should be filtered
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } as any,
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] } as any,
            { type: "redacted_thinking", data: "opaque" } as any,
          ],
        },
        { role: "user", content: "Continue" },
      ],
      system: null,
      metadata: null,
      stop_sequences: null,
      stream: false,
      temperature: null,
      top_p: null,
      top_k: null,
      tools: null,
      tool_choice: null,
      thinking: null,
      service_tier: null,
    }
    const result = translateToOpenAI(payload)
    // The assistant message should be completely dropped
    const assistantMsgs = result.messages.filter(m => m.role === "assistant")
    expect(assistantMsgs).toHaveLength(0)
    // Should have two user messages
    const userMsgs = result.messages.filter(m => m.role === "user")
    expect(userMsgs).toHaveLength(2)
  })

  test("sanitizes tool schema fields", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      system: null,
      metadata: null,
      stop_sequences: null,
      stream: false,
      temperature: null,
      top_p: null,
      top_k: null,
      tools: [
        {
          name: "read",
          description: "Read file",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
          defer_loading: true,
        } as any,
      ],
      tool_choice: null,
      thinking: null,
      service_tier: null,
    }
    const result = translateToOpenAI(payload)
    // Tool should be translated without extended fields
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0]!.function.name).toBe("read")
    // The original tool object was mutated but only standard fields are copied
  })

  test("preserves server-side tool detection after sanitization", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Search for TypeScript" }],
      system: null,
      metadata: null,
      stop_sequences: null,
      stream: false,
      temperature: null,
      top_p: null,
      top_k: null,
      tools: [
        {
          name: "web_search",
          description: "Search the web",
          input_schema: { type: "object" },
          type: "web_search_20260209",
          cache_control: { type: "ephemeral" },
        } as any,
      ],
      tool_choice: null,
      thinking: null,
      service_tier: null,
    }
    const result = translateToOpenAI(payload)
    // Server-side tool should still be detected
    expect(result.serverSideToolNames).toContain("web_search")
  })

  test("handles conversation with mixed content types", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "redacted_thinking", data: "opaque" } as any,
            { type: "text", text: "Here is my response" },
            { type: "tool_use", id: "tu_1", name: "read", input: { path: "/file" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "file content", is_error: false },
            { type: "tool_reference", tool_name: "read" } as any,
            { type: "text", text: "What do you think?" },
          ],
        },
      ],
      system: null,
      metadata: null,
      stop_sequences: null,
      stream: false,
      temperature: null,
      top_p: null,
      top_k: null,
      tools: null,
      tool_choice: null,
      thinking: null,
      service_tier: null,
    }
    const result = translateToOpenAI(payload)

    // Should have: system (if any), user, assistant (with tool_call), tool, user
    const assistantMsg = result.messages.find(m => m.role === "assistant")
    expect(assistantMsg?.tool_calls).toHaveLength(1)
    // thinking should be included in content, redacted_thinking filtered
    expect(assistantMsg?.content).toContain("Let me think...")
    expect(assistantMsg?.content).toContain("Here is my response")

    // Tool message should exist
    const toolMsg = result.messages.find(m => m.role === "tool")
    expect(toolMsg).toBeDefined()

    // Final user message should not have tool_reference
    const userMsgs = result.messages.filter(m => m.role === "user")
    const lastUserMsg = userMsgs[userMsgs.length - 1]
    expect(lastUserMsg?.content).toBe("What do you think?")
  })
})

// ===========================================================================
// Constants Completeness Tests
// ===========================================================================

describe("sanitization constants completeness", () => {
  test("UNSUPPORTED_CONTENT_TYPES contains all known unsupported types", () => {
    const expectedTypes = [
      "server_tool_use",
      "web_search_tool_result",
      "web_fetch_tool_result",
      "code_execution_tool_result",
      "bash_code_execution_tool_result",
      "text_editor_code_execution_tool_result",
      "mcp_tool_use",
      "mcp_tool_result",
      "tool_reference",
      "redacted_thinking",
      "container_upload",
      "connector_text",
      "search_result",
      "citations",
      "citation",
    ]
    for (const type of expectedTypes) {
      expect(UNSUPPORTED_CONTENT_TYPES.has(type)).toBe(true)
    }
  })

  test("BLOCK_METADATA_TO_STRIP contains expected fields", () => {
    expect(BLOCK_METADATA_TO_STRIP).toContain("cache_control")
    expect(BLOCK_METADATA_TO_STRIP).toContain("citations")
  })

  test("TOOL_USE_FIELDS_TO_STRIP contains expected fields", () => {
    expect(TOOL_USE_FIELDS_TO_STRIP).toContain("caller")
  })

  test("TOOL_SCHEMA_FIELDS_TO_STRIP contains expected fields", () => {
    expect(TOOL_SCHEMA_FIELDS_TO_STRIP).toContain("cache_control")
    expect(TOOL_SCHEMA_FIELDS_TO_STRIP).toContain("defer_loading")
    expect(TOOL_SCHEMA_FIELDS_TO_STRIP).toContain("strict")
    expect(TOOL_SCHEMA_FIELDS_TO_STRIP).toContain("eager_input_streaming")
  })
})
