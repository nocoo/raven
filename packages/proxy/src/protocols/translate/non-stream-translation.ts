import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "./../../upstream/copilot-openai"

import { translateModelName } from "../anthropic/preprocess"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "../anthropic/types"

// ---------------------------------------------------------------------------
// Sanitization Constants
// ---------------------------------------------------------------------------

/**
 * Content block types that are NOT supported by OpenAI/Copilot and must be filtered out.
 * These come from Claude Code's extended features (MCP, tool search, server-side execution, etc.)
 */
export const UNSUPPORTED_CONTENT_TYPES = new Set([
  // Server-side tool related (Anthropic API executes these)
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  // MCP (Model Context Protocol) related
  "mcp_tool_use",
  "mcp_tool_result",
  // Tool search beta feature
  "tool_reference",
  // Extended thinking (opaque, cannot be processed)
  "redacted_thinking",
  // Container/connector features
  "container_upload",
  "connector_text",
  // Search/citations
  "search_result",
  "citations",
  "citation",
])

/**
 * Metadata fields on content blocks that should be stripped (Anthropic caching).
 */
export const BLOCK_METADATA_TO_STRIP = ["cache_control", "citations"] as const

/**
 * Extended fields on tool_use blocks that should be stripped (tool search beta).
 */
export const TOOL_USE_FIELDS_TO_STRIP = ["caller"] as const

/**
 * Extended fields on tool schema definitions that should be stripped.
 */
export const TOOL_SCHEMA_FIELDS_TO_STRIP = [
  "cache_control",
  "defer_loading",
  "strict",
  "eager_input_streaming",
] as const

import { mapOpenAIStopReasonToAnthropic } from "./stop-reason"

interface MessageTranslateFlags {
  sanitizeOrphanedToolResults: boolean
  reorderToolResults: boolean
}

// ---------------------------------------------------------------------------
// Sanitization Helpers
// ---------------------------------------------------------------------------

/**
 * Filter out unsupported content block types and strip metadata from remaining blocks.
 * Returns a new array with only supported blocks.
 */
export function filterContentBlocks<T extends { type: string }>(
  blocks: T[],
): T[] {
  const filtered: T[] = []
  for (const block of blocks) {
    // Skip unsupported block types
    if (UNSUPPORTED_CONTENT_TYPES.has(block.type)) {
      continue
    }
    // Strip metadata from remaining blocks
    stripBlockMetadata(block)
    filtered.push(block)
  }
  return filtered
}

/**
 * Strip Anthropic-only metadata fields from a content block (mutates in place).
 */
export function stripBlockMetadata(block: Record<string, unknown>): void {
  if ("cache_control" in block) {
    delete block.cache_control
  }
  if ("citations" in block) {
    delete block.citations
  }
}

/**
 * Strip extended fields from a tool_use block (mutates in place).
 */
export function stripToolUseFields(block: AnthropicToolUseBlock): void {
  const blockAny = block as unknown as Record<string, unknown>
  if ("caller" in blockAny) {
    delete blockAny.caller
  }
}

/**
 * Strip extended fields from tool schema definitions (mutates in place).
 */
export function sanitizeToolDefinitions(tools: AnthropicTool[]): void {
  for (const tool of tools) {
    sanitizeSingleToolDefinition(tool)
  }
}

/**
 * Strip extended fields from a single tool schema definition (mutates in place).
 * Used by translateAnthropicToolsToOpenAI to avoid array allocation overhead.
 */
function sanitizeSingleToolDefinition(tool: AnthropicTool): void {
  const toolAny = tool as unknown as Record<string, unknown>
  if ("cache_control" in toolAny) {
    delete toolAny.cache_control
  }
  if ("defer_loading" in toolAny) {
    delete toolAny.defer_loading
  }
  if ("strict" in toolAny) {
    delete toolAny.strict
  }
  if ("eager_input_streaming" in toolAny) {
    delete toolAny.eager_input_streaming
  }
}

// ---------------------------------------------------------------------------
// Payload translation
// ---------------------------------------------------------------------------

// Note: Server-side tool detection is now handled by preprocessPayload() in preprocess.ts.
// The translation layer no longer tracks serverSideToolNames.

/**
 * Target format for translation, determining how certain features are handled:
 * - "openai-reasoning": OpenAI upstream that supports reasoning_effort (o1/o3)
 * - "openai": OpenAI upstream without reasoning support
 * - "copilot": Default Copilot path
 */
export type TranslateTargetFormat = "openai-reasoning" | "openai" | "copilot"

export interface TranslateToOpenAIOptions {
  targetFormat?: TranslateTargetFormat
  anthropicBeta?: string | null
  /** When true, drop tool_result blocks referencing unknown tool_use ids (OPT-1). */
  sanitizeOrphanedToolResults?: boolean
  /** When true, reorder tool_result blocks to match the prior assistant's tool_calls order (OPT-2). */
  reorderToolResults?: boolean
}

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options?: TranslateToOpenAIOptions,
): ChatCompletionsPayload {
  const result: ChatCompletionsPayload = {
    model: translateModelName(payload.model, options?.anthropicBeta ?? null),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system ?? undefined,
      {
        sanitizeOrphanedToolResults: options?.sanitizeOrphanedToolResults ?? false,
        reorderToolResults: options?.reorderToolResults ?? false,
      },
    ),
    max_tokens: payload.max_tokens,
  }

  if (payload.stop_sequences) result.stop = payload.stop_sequences
  if (payload.stream !== undefined) result.stream = payload.stream
  if (payload.temperature !== undefined) result.temperature = payload.temperature
  if (payload.top_p !== undefined) result.top_p = payload.top_p
  if (payload.metadata?.user_id) result.user = payload.metadata.user_id

  const openAITools = translateAnthropicToolsToOpenAI(payload.tools)
  if (openAITools) result.tools = openAITools

  const toolChoice = translateAnthropicToolChoiceToOpenAI(payload.tool_choice)
  if (toolChoice) result.tool_choice = toolChoice

  // Thinking → reasoning_effort translation (only for reasoning-capable OpenAI upstreams)
  if (options?.targetFormat === "openai-reasoning" && payload.thinking?.type === "enabled") {
    const budget = payload.thinking.budget_tokens ?? 0
    if (budget >= 10000) {
      result.reasoning_effort = "high"
    } else if (budget >= 5000) {
      result.reasoning_effort = "medium"
    } else if (budget >= 2000) {
      result.reasoning_effort = "low"
    } else {
      result.reasoning_effort = "minimal"
    }
  }
  // For "openai" (non-reasoning) and "copilot": thinking param is dropped

  return result
}

// Pre-compiled regexes for model name translation moved to
// protocols/anthropic/preprocess; imported at the top of this file.

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
  flags: MessageTranslateFlags,
): Array<Message> {
  const result: Array<Message> = []
  appendSystemPrompt(system, result)

  // Context state for OPT-1 (sanitize) and OPT-2 (reorder).
  // Tracks tool_use IDs from the most recent assistant message, in order.
  let pendingToolCallIds: string[] = []

  for (const message of anthropicMessages) {
    if (message.role === "assistant") {
      pendingToolCallIds = appendAssistantMessage(message, result)
    } else {
      appendUserMessage(message, pendingToolCallIds, flags, result)
      pendingToolCallIds = EMPTY_IDS
    }
  }

  return result
}

const EMPTY_IDS: string[] = []

function appendSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
  out: Array<Message>,
): void {
  if (!system) return
  const content = typeof system === "string"
    ? system
    : system.map((block) => block.text).join("\n\n")
  out.push({ role: "system", content, name: null, tool_calls: null, tool_call_id: null })
}

function appendUserMessage(
  message: AnthropicUserMessage,
  pendingToolCallIds: string[],
  flags: MessageTranslateFlags,
  out: Array<Message>,
): void {


  if (Array.isArray(message.content)) {
    const flagsActive = flags.sanitizeOrphanedToolResults || flags.reorderToolResults

    if (!flagsActive) {
      // Fast path: no tool-result reordering/sanitization. Single pass:
      // filter unsupported, push tool messages directly, lazily collect non-tool-result blocks.
      // Tool results must come first to maintain protocol: tool_use -> tool_result -> user.
      let otherBlocks: AnthropicUserContentBlock[] | null = null
      const content = message.content
      for (let i = 0; i < content.length; i++) {
        const block = content[i]!
        if (UNSUPPORTED_CONTENT_TYPES.has(block.type)) continue
        stripBlockMetadata(block as unknown as Record<string, unknown>)
        if (block.type === "tool_result") {
          const trBlock = block as AnthropicToolResultBlock
          out.push({
            role: "tool",
            tool_call_id: trBlock.tool_use_id,
            content: mapContent(trBlock.content),
            name: null,
            tool_calls: null,
          })
        } else {
          if (otherBlocks === null) otherBlocks = []
          otherBlocks.push(block)
        }
      }

      if (otherBlocks !== null) {
        out.push({
          role: "user",
          content: mapContent(otherBlocks),
          name: null,
          tool_calls: null,
          tool_call_id: null,
        })
      }
      return
    }

    // Slow path: tool-result sanitization/reordering active.
    const filteredContent = filterContentBlocks(message.content)
    let toolResultBlocks: AnthropicToolResultBlock[] = []
    const otherBlocks: AnthropicUserContentBlock[] = []
    for (const block of filteredContent) {
      if (block.type === "tool_result") {
        toolResultBlocks.push(block as AnthropicToolResultBlock)
      } else {
        otherBlocks.push(block)
      }
    }

    // OPT-1: Drop tool_result blocks referencing non-existent tool_use IDs.
    if (flags.sanitizeOrphanedToolResults) {
      const validIds = new Set(pendingToolCallIds)
      toolResultBlocks = toolResultBlocks.filter((block) => validIds.has(block.tool_use_id))
    }

    // OPT-2: Reorder tool results to match tool_calls array order
    if (flags.reorderToolResults && pendingToolCallIds.length > 0 && toolResultBlocks.length > 1) {
      const idOrder = new Map(pendingToolCallIds.map((id, i) => [id, i]))
      toolResultBlocks.sort((a, b) => {
        const aIdx = idOrder.get(a.tool_use_id) ?? pendingToolCallIds.length
        const bIdx = idOrder.get(b.tool_use_id) ?? pendingToolCallIds.length
        return aIdx - bIdx
      })
    }

    for (const block of toolResultBlocks) {
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
        name: null,
        tool_calls: null,
      })
    }

    if (otherBlocks.length > 0) {
      out.push({
        role: "user",
        content: mapContent(otherBlocks),
        name: null,
        tool_calls: null,
        tool_call_id: null,
      })
    }
  } else {
    out.push({
      role: "user",
      content: mapContent(message.content),
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  }
}

function appendAssistantMessage(
  message: AnthropicAssistantMessage,
  out: Array<Message>,
): string[] {
  if (!Array.isArray(message.content)) {
    out.push({
      role: "assistant",
      content: mapContent(message.content),
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
    return EMPTY_IDS
  }

  // Single-pass: filter unsupported, strip metadata, categorize, build filtered list
  // (filteredContent is reused for the no-tool-use fallback to preserve original block order).
  const filteredContent: AnthropicAssistantContentBlock[] = []
  const toolUseBlocks: AnthropicToolUseBlock[] = []
  const textParts: string[] = []
  const thinkingParts: string[] = []

  const content = message.content
  for (let i = 0; i < content.length; i++) {
    const block = content[i]!
    if (UNSUPPORTED_CONTENT_TYPES.has(block.type)) continue
    stripBlockMetadata(block as unknown as Record<string, unknown>)
    filteredContent.push(block)
    switch (block.type) {
      case "tool_use":
        stripToolUseFields(block as AnthropicToolUseBlock)
        toolUseBlocks.push(block as AnthropicToolUseBlock)
        break
      case "text":
        textParts.push((block as AnthropicTextBlock).text)
        break
      case "thinking":
        thinkingParts.push((block as AnthropicThinkingBlock).thinking)
        break
    }
  }

  // If all content was filtered out, drop the entire message
  if (filteredContent.length === 0) {
    return EMPTY_IDS
  }

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks
  // Original order: all text first, then all thinking
  // Avoid double-spread: combine without intermediate allocation
  let allTextContent: string | null = null
  if (textParts.length > 0) {
    allTextContent = thinkingParts.length === 0
      ? textParts.join("\n\n")
      : textParts.concat(thinkingParts).join("\n\n")
  } else if (thinkingParts.length > 0) {
    allTextContent = thinkingParts.join("\n\n")
  }

  if (toolUseBlocks.length > 0) {
    const ids: string[] = new Array(toolUseBlocks.length)
    const toolCalls = new Array(toolUseBlocks.length)
    for (let i = 0; i < toolUseBlocks.length; i++) {
      const toolUse = toolUseBlocks[i]!
      ids[i] = toolUse.id
      toolCalls[i] = {
        id: toolUse.id,
        type: "function",
        function: {
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input),
        },
      }
    }
    out.push({
      role: "assistant",
      content: allTextContent || null,
      tool_calls: toolCalls,
      name: null,
      tool_call_id: null,
    })
    return ids
  }

  out.push({
    role: "assistant",
    content: mapContent(filteredContent),
    name: null,
    tool_calls: null,
    tool_call_id: null,
  })
  return EMPTY_IDS
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  // Single-pass: detect image and collect text simultaneously
  let hasImage = false
  const textParts: string[] = []

  for (const block of content) {
    switch (block.type) {
      case "image":
        hasImage = true
        break
      case "text":
        textParts.push(block.text)
        break
      case "thinking":
        textParts.push((block as AnthropicThinkingBlock).thinking)
        break
    }
  }

  // Fast path: no images, just join text
  if (!hasImage) {
    return textParts.length > 0 ? textParts.join("\n\n") : null
  }

  // Slow path with images: build ContentPart array
  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })
        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: (block as AnthropicThinkingBlock).thinking })
        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
        break
      }
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | null | undefined,
): Array<Tool> | null {
  if (!anthropicTools) {
    return null
  }

  return anthropicTools.map((tool) => {
    // Sanitize tool schema - strip Anthropic-only fields (direct call, no array wrapper)
    sanitizeSingleToolDefinition(tool)

    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }
  })
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return null
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return null
    }
    case "none": {
      return "none"
    }
    default: {
      return null
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
  originalModel?: string,
): AnthropicResponse {
  // Merge content from all choices
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  // Note: GitHub Copilot doesn't generate thinking blocks, so we don't include them in responses

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: originalModel ?? response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: response.usage?.prompt_tokens_details?.cached_tokens ?? null,
      service_tier: null,
    },
  }
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | null | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}
