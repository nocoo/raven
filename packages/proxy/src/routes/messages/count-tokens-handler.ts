import type { Context } from "hono"

import { logger } from "./../../util/logger"
import { state } from "./../../lib/state"
import { getTokenCount } from "./../../lib/tokenizer"

import { type AnthropicMessagesPayload } from "../../protocols/anthropic/types"
import { translateToOpenAI } from "../../protocols/translate/non-stream-translation"

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const openAIPayload = translateToOpenAI(anthropicPayload, { anthropicBeta: anthropicBeta ?? null })

    const translatedModel = openAIPayload.model
    const selectedModel = state.models?.data.find(
      (model) => model.id === translatedModel || model.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      logger.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (anthropicPayload.model.startsWith("claude")) {
          tokenCount.input = tokenCount.input + 346
        } else if (anthropicPayload.model.startsWith("grok")) {
          tokenCount.input = tokenCount.input + 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (anthropicPayload.model.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (anthropicPayload.model.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    logger.info(`Token count: ${finalTokenCount}`)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    logger.error("Error counting tokens", { error: String(error) })
    return c.json({
      input_tokens: 1,
    })
  }
}
