import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { createResponses, type ResponsesPayload } from "../../services/copilot/create-responses"
import { forwardError } from "../../lib/error"
import type { ServerSentEvent } from "../../util/sse"

export const handleResponses = async (c: Context) => {
  let payload: ResponsesPayload

  try {
    payload = await c.req.json<ResponsesPayload>()
  } catch {
    return c.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, 400)
  }

  try {
    const response = await createResponses(payload)

    // Streaming: passthrough SSE events
    if (payload.stream && isAsyncIterable(response)) {
      return streamSSE(c, async (stream) => {
        for await (const chunk of response as AsyncIterable<ServerSentEvent>) {
          if (chunk.event) {
            await stream.writeSSE({ event: chunk.event, data: chunk.data })
          } else {
            await stream.writeSSE({ data: chunk.data })
          }
        }
      })
    }

    // Non-streaming: return JSON
    return c.json(response)
  } catch (error) {
    return forwardError(c, error)
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}
