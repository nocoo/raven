import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

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
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"
import { state } from "~/lib/state"
import { logger } from "~/util/logger"

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const base = {
    model: translateModelName(payload.model),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system ?? undefined,
    ),
    max_tokens: payload.max_tokens,
  }

  const optional: Partial<ChatCompletionsPayload> = {}
  if (payload.stop_sequences) optional.stop = payload.stop_sequences
  if (payload.stream !== undefined) optional.stream = payload.stream
  if (payload.temperature !== undefined) optional.temperature = payload.temperature
  if (payload.top_p !== undefined) optional.top_p = payload.top_p
  if (payload.metadata?.user_id) optional.user = payload.metadata.user_id

  const tools = translateAnthropicToolsToOpenAI(payload.tools)
  if (tools) optional.tools = tools

  const toolChoice = translateAnthropicToolChoiceToOpenAI(payload.tool_choice)
  if (toolChoice) optional.tool_choice = toolChoice

  return { ...base, ...optional }
}

function translateModelName(model: string): string {
  // Map from Anthropic SDK model identifiers (hyphenated, with date suffixes)
  // to Copilot model IDs (dot-separated, no date suffix).
  //
  // Examples:
  //   claude-opus-4-6-20250820     → claude-opus-4.6
  //   claude-opus-4-6-1m-20250820  → claude-opus-4.6-1m
  //   claude-sonnet-4-5-20250514   → claude-sonnet-4.5
  //   claude-sonnet-4-20250514     → claude-sonnet-4
  //   claude-haiku-4-5-20251001    → claude-haiku-4.5
  const match = model.match(
    /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:-(1m))?(?:-\d{8})?$/
  )
  if (match) {
    const [, family, major, minor, suffix] = match
    const base = `${family}-${major}.${minor}`
    return suffix ? `${base}-${suffix}` : base
  }

  // No minor version: claude-{family}-{major}[-date]
  const matchNoMinor = model.match(
    /^(claude-(?:opus|sonnet|haiku))-(\d+)(?:-\d{8})?$/
  )
  if (matchNoMinor) {
    const [, family, major] = matchNoMinor
    return `${family}-${major}`
  }

  return model
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)
  const result: Array<Message> = []

  // Context state for OPT-1 (sanitize) and OPT-2 (reorder).
  // Tracks tool_use IDs from the most recent assistant message, in order.
  let pendingToolCallIds: string[] = []

  for (const message of anthropicMessages) {
    if (message.role === "assistant") {
      const translated = handleAssistantMessage(message)
      result.push(...translated)
      pendingToolCallIds = extractToolUseIds(message)
    } else {
      const translated = handleUserMessage(message, pendingToolCallIds)
      result.push(...translated)
      pendingToolCallIds = []
    }
  }

  return [...systemMessages, ...result]
}

/**
 * Extract tool_use block IDs from an assistant message, preserving order.
 * Returns empty array if the message has no tool_use blocks.
 */
function extractToolUseIds(message: AnthropicAssistantMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter(
      (block): block is AnthropicToolUseBlock => block.type === "tool_use",
    )
    .map((block) => block.id)
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system, name: null, tool_calls: null, tool_call_id: null }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText, name: null, tool_calls: null, tool_call_id: null }]
  }
}

function handleUserMessage(
  message: AnthropicUserMessage,
  pendingToolCallIds: string[],
): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    let toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // OPT-1: Drop tool_result blocks referencing non-existent tool_use IDs.
    // When pendingToolCallIds is empty (assistant message was deleted by compaction),
    // ALL tool_results are orphans and should be dropped.
    if (state.optSanitizeOrphanedToolResults) {
      const validIds = new Set(pendingToolCallIds)
      const before = toolResultBlocks.length
      toolResultBlocks = toolResultBlocks.filter((block) => {
        if (validIds.has(block.tool_use_id)) return true
        logger.debug(
          `OPT-1: dropping orphaned tool_result for tool_use_id=${block.tool_use_id}`,
        )
        return false
      })
      if (toolResultBlocks.length < before) {
        logger.debug(
          `OPT-1: dropped ${before - toolResultBlocks.length} orphaned tool_result(s)`,
        )
      }
    }

    // OPT-2: Reorder tool results to match tool_calls array order
    if (state.optReorderToolResults && pendingToolCallIds.length > 0 && toolResultBlocks.length > 1) {
      const idOrder = new Map(pendingToolCallIds.map((id, i) => [id, i]))
      toolResultBlocks.sort((a, b) => {
        const aIdx = idOrder.get(a.tool_use_id) ?? pendingToolCallIds.length
        const bIdx = idOrder.get(b.tool_use_id) ?? pendingToolCallIds.length
        return aIdx - bIdx
      })
    }

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
        name: null,
        tool_calls: null,
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
        name: null,
        tool_calls: null,
        tool_call_id: null,
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
        name: null,
        tool_calls: null,
        tool_call_id: null,
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
          name: null,
          tool_call_id: null,
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(message.content),
          name: null,
          tool_calls: null,
          tool_call_id: null,
        },
      ]
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

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

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
      // No default
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
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
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
    model: response.model,
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
