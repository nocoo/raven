/**
 * Unified server-side tools interception layer.
 *
 * This module handles server-side tools (Tavily web_search) at the Anthropic payload level,
 * making it protocol-agnostic. Both native passthrough and translated paths use the same logic.
 *
 * Key design:
 * - Works on Anthropic payloads directly (no dependency on OpenAI translation)
 * - Uses `sendRequest` injection for testability and path flexibility
 * - Pure mode: all tools are server-side, execute directly
 * - Mixed mode: strip server tools, loop with client tools
 */

import { state } from "../../lib/state"
import { logEmitter } from "../../util/log-emitter"
import { searchTavily, TavilyError } from "../../lib/server-tools/tavily"
import { HTTPError } from "../../lib/error"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTool,
  AnthropicToolUseBlock,
  AnthropicWebSearchResult,
  AnthropicToolResultBlock,
  AnthropicMessage,
} from "./anthropic-types"
import type { ServerToolContext } from "./preprocess"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A function that sends an Anthropic request and returns a non-streaming response.
 * This abstraction allows the same interception logic to work with:
 * - Native path: sendNativeMessages
 * - Translated path: translate → send → translate back
 */
export type SendAnthropicRequestFn = (
  payload: AnthropicMessagesPayload,
) => Promise<AnthropicResponse>

/**
 * Server tool executor function type (for dependency injection in tests).
 */
export type ServerToolExecutorFn = (
  toolName: string,
  input: Record<string, unknown>,
  requestId: string,
) => Promise<{ content: unknown; textContent: string }>

/**
 * Result from server-side tool execution.
 */
export interface ServerToolExecutionResult {
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  content: unknown
}

// ---------------------------------------------------------------------------
// Main Interception Function
// ---------------------------------------------------------------------------

/**
 * Options for server tool interception.
 */
export interface ServerToolInterceptionOptions {
  /** Optional executor for testing (defaults to executeServerTool) */
  executor?: ServerToolExecutorFn
}

/**
 * Wrap a request with server-side tool interception.
 *
 * If no server-side tools are present, the request is sent directly.
 * Otherwise, handles pure mode or mixed mode interception.
 *
 * @param payload - Cleaned Anthropic payload
 * @param serverToolContext - Detection result from preprocessPayload()
 * @param sendRequest - Function to send the Anthropic request
 * @param requestId - For logging correlation
 * @param options - Optional configuration (executor for testing)
 */
export async function withServerToolInterception(
  payload: AnthropicMessagesPayload,
  serverToolContext: ServerToolContext,
  sendRequest: SendAnthropicRequestFn,
  requestId: string,
  options?: ServerToolInterceptionOptions,
): Promise<AnthropicResponse> {
  const executor = options?.executor ?? executeServerTool

  if (!serverToolContext.hasServerSideTools) {
    return sendRequest(payload)
  }

  logEmitter.emitLog({
    ts: Date.now(),
    level: "debug",
    type: "sse_chunk",
    requestId,
    msg: `server-tool interception: mode=${serverToolContext.allServerSide ? "pure" : "mixed"}, tools=${JSON.stringify(serverToolContext.serverSideToolNames)}`,
    data: {
      eventType: "server_tool_check",
      mode: serverToolContext.allServerSide ? "pure" : "mixed",
      serverSideToolNames: serverToolContext.serverSideToolNames,
    },
  })

  if (serverToolContext.allServerSide) {
    return handlePureServerSideTools(payload, serverToolContext, sendRequest, requestId, executor)
  }

  return handleMixedTools(payload, serverToolContext, sendRequest, requestId, executor)
}

// ---------------------------------------------------------------------------
// Pure Mode: All tools are server-side
// ---------------------------------------------------------------------------

/**
 * Pure server-side tool handling.
 * Extract query from user message, call Tavily, inject results,
 * then call upstream (no tools) for the model to synthesize an answer.
 */
async function handlePureServerSideTools(
  payload: AnthropicMessagesPayload,
  serverToolContext: ServerToolContext,
  sendRequest: SendAnthropicRequestFn,
  requestId: string,
  executor: ServerToolExecutorFn,
): Promise<AnthropicResponse> {
  // Extract search query from the last user message
  const query = extractQueryFromPayload(payload)

  if (!query) {
    // No extractable query - send without tools for plain response
    const noToolsPayload: AnthropicMessagesPayload = {
      ...payload,
      tools: null,
      tool_choice: null,
    }
    return sendRequest(noToolsPayload)
  }

  const toolName =
    serverToolContext.serverSideToolNames.find((n) => n === "web_search") ??
    serverToolContext.serverSideToolNames[0] ??
    "web_search"

  logEmitter.emitLog({
    ts: Date.now(),
    level: "info",
    type: "sse_chunk",
    requestId,
    msg: `server-side tool direct call: ${toolName}`,
    data: { eventType: "server_tool_direct", toolName, query },
  })

  // Execute web search
  const searchResult = await executor(toolName, { query }, requestId)

  logEmitter.emitLog({
    ts: Date.now(),
    level: "info",
    type: "sse_chunk",
    requestId,
    msg: `server tool result obtained: ${toolName}`,
    data: {
      eventType: "server_tool_result",
      toolName,
      resultCount: Array.isArray(searchResult.content) ? searchResult.content.length : 1,
    },
  })

  // Inject search results and call upstream for synthesis
  const synthesisPayload: AnthropicMessagesPayload = {
    ...payload,
    tools: null,
    tool_choice: null,
    messages: [
      ...payload.messages,
      {
        role: "user",
        content: `[web_search results for "${query}"]\n\n${searchResult.textContent}`,
      },
    ],
  }

  const synthesisResp = await sendRequest(synthesisPayload)

  // Build native response with server_tool_use + web_search_tool_result + synthesized text
  const toolUseId = `srvtoolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const synthesizedText =
    synthesisResp.content
      ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n\n") ?? ""

  return {
    id: synthesisResp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: synthesisResp.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      {
        type: "server_tool_use",
        id: toolUseId,
        name: toolName,
        input: { query },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: searchResult.content as AnthropicWebSearchResult[],
      },
      {
        type: "text",
        text: synthesizedText,
      },
    ],
    usage: {
      input_tokens: synthesisResp.usage?.input_tokens ?? 0,
      output_tokens: synthesisResp.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: synthesisResp.usage?.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: synthesisResp.usage?.cache_read_input_tokens ?? null,
      service_tier: null,
      server_tool_use: { web_search_requests: 1 },
    },
  }
}

// ---------------------------------------------------------------------------
// Mixed Mode: Client tools + server-side tools
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 5

/**
 * Mixed tool handling: client tools + server-side tools.
 * Strip server-side tool defs, send to upstream with client tools only.
 * If model calls a server-side tool name, execute it and loop.
 */
async function handleMixedTools(
  payload: AnthropicMessagesPayload,
  serverToolContext: ServerToolContext,
  sendRequest: SendAnthropicRequestFn,
  requestId: string,
  executor: ServerToolExecutorFn,
): Promise<AnthropicResponse> {
  // Filter out server-side tools from definitions
  const clientTools = filterServerSideTools(payload.tools ?? [], serverToolContext.serverSideToolNames)

  let iteration = 0
  let currentPayload: AnthropicMessagesPayload = {
    ...payload,
    tools: clientTools.length > 0 ? clientTools : null,
  }

  while (iteration < MAX_ITERATIONS) {
    iteration++

    const response = await sendRequest({
      ...currentPayload,
      tool_choice: iteration > 1
        ? { type: "auto", name: null }
        : (currentPayload.tool_choice ?? { type: "auto", name: null }),
    })

    // Check for tool_use blocks in response
    const toolUseBlocks = (response.content ?? []).filter(
      (b): b is AnthropicToolUseBlock => b.type === "tool_use",
    )

    if (toolUseBlocks.length === 0) {
      // No tool calls - return response
      return response
    }

    // Find server-side tool call
    const serverToolUse = toolUseBlocks.find((tu) =>
      serverToolContext.serverSideToolNames.includes(tu.name),
    )

    if (!serverToolUse) {
      // Client-side tool call - return to client
      return response
    }

    // Execute server-side tool
    const toolName = serverToolUse.name
    const toolInput = serverToolUse.input as Record<string, unknown>

    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "sse_chunk",
      requestId,
      msg: `intercepting server-side tool: ${toolName}`,
      data: { eventType: "server_tool_intercept", toolName, toolInput },
    })

    const toolResult = await executor(toolName, toolInput, requestId)

    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "sse_chunk",
      requestId,
      msg: `server tool result injected: ${toolName}`,
      data: {
        eventType: "server_tool_result",
        toolName,
        resultLength: JSON.stringify(toolResult.content).length,
      },
    })

    // Inject tool result and continue loop
    const toolResultBlock: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: serverToolUse.id,
      content: JSON.stringify(toolResult.content),
      is_error: null,
    }
    const assistantMessage: AnthropicMessage = {
      role: "assistant",
      content: response.content,
    }
    const userMessage: AnthropicMessage = {
      role: "user",
      content: [toolResultBlock],
    }
    currentPayload = {
      ...currentPayload,
      messages: [
        ...currentPayload.messages,
        assistantMessage,
        userMessage,
      ],
    }
  }

  throw new Error("Server tool loop exceeded maximum iterations")
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Extract a search query from the payload's last user message.
 */
function extractQueryFromPayload(payload: AnthropicMessagesPayload): string {
  const messages = payload.messages
  if (!messages || messages.length === 0) return ""

  // Find last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as AnthropicMessage | undefined
    if (msg && msg.role === "user") {
      return extractTextFromContent(msg.content)
    }
  }
  return ""
}

/**
 * Extract plain text from Anthropic message content.
 */
function extractTextFromContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
  }
  return ""
}

/**
 * Filter out server-side tools from tool definitions.
 */
function filterServerSideTools(
  tools: AnthropicTool[],
  serverSideToolNames: string[],
): AnthropicTool[] {
  const serverSet = new Set(serverSideToolNames)
  return tools.filter((t) => !serverSet.has(t.name))
}

/**
 * Execute a server-side tool by name.
 * Currently only supports web_search via Tavily.
 */
async function executeServerTool(
  toolName: string,
  input: Record<string, unknown>,
  requestId: string,
): Promise<{ content: unknown; textContent: string }> {
  if (toolName === "web_search" && state.stWebSearchApiKey) {
    try {
      // Build search input, only including optional fields if they have values
      const searchInput: { query: string; count?: number; offset?: number } = {
        query: (input.query as string) || "",
      }
      if (typeof input.count === "number") searchInput.count = input.count
      if (typeof input.offset === "number") searchInput.offset = input.offset

      const result = await searchTavily(state.stWebSearchApiKey, searchInput)
      return {
        content: result.content,
        textContent: result.textContent,
      }
    } catch (err) {
      if (err instanceof TavilyError) {
        logEmitter.emitLog({
          ts: Date.now(),
          level: "error",
          type: "sse_chunk",
          requestId,
          msg: `server tool error: ${toolName} - ${err.message}`,
          data: {
            eventType: "server_tool_error",
            toolName,
            errorType: err.type,
            statusCode: err.statusCode,
          },
        })
        throw new HTTPError(err.message, err.statusCode, err.message)
      }
      throw err
    }
  }

  throw new HTTPError(
    `Server tool ${toolName} is not available`,
    500,
    `Server tool ${toolName} is not available`,
  )
}
