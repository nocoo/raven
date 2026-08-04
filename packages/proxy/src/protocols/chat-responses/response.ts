import type { ChatCompletionResponse } from "../../upstream/copilot-openai"
import { isResponsesFailure, responsesFailureMessage } from "./errors"
import { mapResponsesFinishReason } from "./finish-reason"

export class ResponsesProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponsesProtocolError"
  }
}

export function responsesJsonToChatCompletion(
  body: unknown,
  fallbackModel: string,
): ChatCompletionResponse {
  if (isResponsesFailure(body)) {
    throw new ResponsesProtocolError(responsesFailureMessage(body))
  }

  const b = (body && typeof body === "object" ? body : {}) as {
    id?: unknown
    model?: unknown
    created_at?: unknown
    output?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      total_tokens?: number
    } | null
    status?: unknown
    incomplete_details?: { reason?: unknown } | null
  }

  const model =
    typeof b.model === "string" && b.model.length > 0 ? b.model : fallbackModel
  const id = typeof b.id === "string" && b.id.length > 0 ? b.id : `resp_unknown`
  const created =
    typeof b.created_at === "number"
      ? Math.floor(b.created_at)
      : Math.floor(Date.now() / 1000)

  const { content, toolCalls, refusal } = extractOutput(b.output)
  const finish_reason = mapResponsesFinishReason(b)

  const prompt_tokens = b.usage?.input_tokens ?? 0
  const completion_tokens = b.usage?.output_tokens ?? 0
  const total_tokens =
    b.usage?.total_tokens ?? prompt_tokens + completion_tokens

  const hasTools = toolCalls != null && toolCalls.length > 0
  let messageContent: string | null =
    hasTools && (content === "" || content == null) ? null : content
  if (refusal && !hasTools && (messageContent === "" || messageContent == null)) {
    messageContent = null
  }

  return {
    id,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: messageContent,
          tool_calls: hasTools ? toolCalls : null,
          ...(refusal ? { refusal } : {}),
        },
        logprobs: null,
        finish_reason,
      },
    ],
    usage: b.usage
      ? {
          prompt_tokens,
          completion_tokens,
          total_tokens,
          prompt_tokens_details: null,
        }
      : null,
  }
}

function extractOutput(output: unknown): {
  content: string | null
  toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> | null
  refusal: string | null
} {
  if (!Array.isArray(output)) {
    return { content: null, toolCalls: null, refusal: null }
  }

  const textParts: string[] = []
  const refusalParts: string[] = []
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const it = item as {
      type?: string
      call_id?: string
      name?: string
      arguments?: string
      content?: unknown
      refusal?: unknown
    }

    if (it.type === "function_call") {
      const callId = typeof it.call_id === "string" ? it.call_id : ""
      if (!callId) {
        throw new ResponsesProtocolError(
          "function_call missing call_id; cannot map to chat tool_calls[].id",
        )
      }
      toolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: typeof it.name === "string" ? it.name : "",
          arguments:
            typeof it.arguments === "string"
              ? it.arguments
              : JSON.stringify(it.arguments ?? {}),
        },
      })
      continue
    }

    if (typeof it.refusal === "string" && it.refusal.length > 0) {
      refusalParts.push(it.refusal)
    }

    if (it.type === "message" || it.content != null) {
      collectTextAndRefusal(it.content, textParts, refusalParts)
    }
  }

  const content =
    textParts.length > 0
      ? textParts.join("")
      : toolCalls.length > 0
        ? null
        : refusalParts.length > 0
          ? null
          : ""
  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    refusal: refusalParts.length > 0 ? refusalParts.join("") : null,
  }
}

function collectTextAndRefusal(
  content: unknown,
  textOut: string[],
  refusalOut: string[],
): void {
  if (typeof content === "string") {
    textOut.push(content)
    return
  }
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const p = part as { type?: string; text?: string; refusal?: string }
    if (p.type === "refusal" && typeof p.refusal === "string") {
      refusalOut.push(p.refusal)
      continue
    }
    if (typeof p.refusal === "string" && p.refusal.length > 0) {
      refusalOut.push(p.refusal)
    }
    if (
      (p.type === "output_text" || p.type === "text" || p.text != null) &&
      typeof p.text === "string" &&
      p.type !== "refusal"
    ) {
      textOut.push(p.text)
    }
  }
}
