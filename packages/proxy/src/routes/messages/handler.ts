import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { logger } from "~/util/logger"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug(`Anthropic request payload: ${JSON.stringify(anthropicPayload)}`)

  const openAIPayload = translateToOpenAI(anthropicPayload)
  logger.debug(`Translated OpenAI request payload: ${JSON.stringify(openAIPayload)}`)

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    logger.debug(`Non-streaming response from Copilot: ${JSON.stringify(response).slice(-400)}`)
    const anthropicResponse = translateToAnthropic(response)
    logger.debug(`Translated Anthropic response: ${JSON.stringify(anthropicResponse)}`)
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      logger.debug(`Copilot raw stream event: ${JSON.stringify(rawEvent)}`)
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        logger.debug(`Translated Anthropic event: ${JSON.stringify(event)}`)
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
