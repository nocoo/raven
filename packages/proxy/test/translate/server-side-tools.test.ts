import { describe, expect, test } from "bun:test"
import { isServerSideTool, type AnthropicTool } from "../../src/routes/messages/anthropic-types"

describe("isServerSideTool", () => {
  test("returns true for web_search_20260209", () => {
    const tool: AnthropicTool = {
      name: "web_search",
      description: "Search the web",
      input_schema: { type: "object" },
      type: "web_search_20260209",
    }
    expect(isServerSideTool(tool)).toBe(true)
  })

  test("returns true for code_execution_20250522", () => {
    const tool: AnthropicTool = {
      name: "code_execution",
      description: "Execute code",
      input_schema: { type: "object" },
      type: "code_execution_20250522",
    }
    expect(isServerSideTool(tool)).toBe(true)
  })

  test("returns false for custom type", () => {
    const tool: AnthropicTool = {
      name: "my_tool",
      description: "My tool",
      input_schema: { type: "object" },
      type: "custom",
    }
    expect(isServerSideTool(tool)).toBe(false)
  })

  test("returns false when type is undefined", () => {
    const tool: AnthropicTool = {
      name: "my_tool",
      description: "My tool",
      input_schema: { type: "object" },
    }
    expect(isServerSideTool(tool)).toBe(false)
  })

  test("returns false for non-date-suffix type", () => {
    const tool: AnthropicTool = {
      name: "my_tool",
      description: "My tool",
      input_schema: { type: "object" },
      type: "some_type",
    }
    expect(isServerSideTool(tool)).toBe(false)
  })

  test("returns false for type with invalid date format", () => {
    const tool: AnthropicTool = {
      name: "my_tool",
      description: "My tool",
      input_schema: { type: "object" },
      type: "tool_2025-01-01",
    }
    expect(isServerSideTool(tool)).toBe(false)
  })

  test("returns true for date-suffix type with underscores", () => {
    const tool: AnthropicTool = {
      name: "my_server_tool",
      description: "Server tool",
      input_schema: { type: "object" },
      type: "my_server_tool_20260101",
    }
    expect(isServerSideTool(tool)).toBe(true)
  })
})
