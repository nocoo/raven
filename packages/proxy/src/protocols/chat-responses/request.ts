import { ClientInputError } from "../../lib/error"
import type { ResponsesPayload } from "../../upstream/copilot-responses"
import { sanitizeCopilotResponsesSampling } from "../responses/sampling"
import type { ChatViaResponsesClientReq } from "./types"

/** Only fields present on official Responses create schema. */
const PASSTHROUGH_KEYS = [
  "temperature",
  "top_p",
  "user",
] as const

/** Local rejects — must be called from strategy.dispatch (Runner try). */
export function assertChatViaResponsesSupported(
  chat: ChatViaResponsesClientReq,
): void {
  if (chat.n != null && chat.n !== 1) {
    throw new ClientInputError(
      `n=${chat.n} is not supported on chat-via-responses shim; only n=1 is allowed`,
    )
  }
  if (chat.stop != null) {
    const empty =
      (typeof chat.stop === "string" && chat.stop.length === 0) ||
      (Array.isArray(chat.stop) && chat.stop.length === 0)
    if (!empty) {
      throw new ClientInputError(
        "stop is not supported on chat-via-responses shim",
      )
    }
  }
}

export function chatRequestToResponses(
  chat: ChatViaResponsesClientReq,
): ResponsesPayload {
  const maxOut =
    chat.max_completion_tokens ?? chat.max_tokens ?? undefined

  const payload: ResponsesPayload = {
    model: chat.model,
    input: messagesToInput(chat.messages),
    stream: !!chat.stream,
  }

  if (maxOut != null) {
    payload.max_output_tokens = maxOut
  }

  if (chat.tools && chat.tools.length > 0) {
    payload.tools = chat.tools.map((t) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description ?? undefined,
      parameters: t.function.parameters ?? {},
      strict: t.function.strict ?? false,
    }))
  }

  if (chat.tool_choice != null) {
    payload.tool_choice = mapToolChoice(chat.tool_choice)
  }

  if (chat.response_format != null) {
    payload.text = mapResponseFormat(chat.response_format)
  }

  if (chat.reasoning_effort != null) {
    payload.reasoning = { effort: chat.reasoning_effort }
  }

  for (const k of PASSTHROUGH_KEYS) {
    const v = chat[k]
    if (v !== undefined && v !== null) {
      payload[k] = v
    }
  }

  return sanitizeCopilotResponsesSampling(payload)
}

function mapToolChoice(
  tc: NonNullable<ChatViaResponsesClientReq["tool_choice"]>,
): unknown {
  if (typeof tc === "string") return tc
  if (
    typeof tc === "object" &&
    tc !== null &&
    tc.type === "function" &&
    tc.function?.name
  ) {
    return { type: "function", name: tc.function.name }
  }
  return tc
}

function mapResponseFormat(
  rf: NonNullable<ChatViaResponsesClientReq["response_format"]>,
): { format: Record<string, unknown> } {
  if (rf.type === "json_schema") {
    return {
      format: {
        type: "json_schema",
        ...(("json_schema" in rf && rf.json_schema) || {}),
      },
    }
  }
  return { format: { type: rf.type } }
}

function messagesToInput(messages: ChatViaResponsesClientReq["messages"]): unknown[] {
  const input: unknown[] = []
  for (const msg of messages) {
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: contentToString(msg.content),
      })
      continue
    }

    if (msg.role === "assistant") {
      // EasyInputMessage content parts use input_text (not output_text), even for
      // prior assistant turns fed back as input. See OpenAI migrate-to-responses.
      if (msg.content != null && msg.content !== "") {
        input.push({
          role: "assistant",
          content: contentToInputParts(msg.content, "input_text"),
        })
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })
        }
      }
      continue
    }

    // system | developer | user
    input.push({
      role: msg.role,
      content: contentToInputParts(msg.content, "input_text"),
    })
  }
  return input
}

function contentToString(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content)
  return content
    .map((p) =>
      typeof p === "object" && p && "text" in p
        ? String((p as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
}

function contentToInputParts(
  content: unknown,
  textType: "input_text" | "output_text",
): unknown {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content)

  const parts: unknown[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const p = part as {
      type?: string
      text?: string
      image_url?: { url?: string } | string
    }
    if (p.type === "text" || p.text != null) {
      parts.push({ type: textType, text: p.text ?? "" })
    } else if (p.type === "image_url") {
      const url =
        typeof p.image_url === "string" ? p.image_url : p.image_url?.url
      if (url) {
        parts.push({ type: "input_image", image_url: url })
      }
    }
  }
  if (parts.length === 0) return ""
  if (
    parts.length === 1 &&
    typeof content[0] === "object" &&
    content[0] !== null &&
    (content[0] as { type?: string }).type === "text"
  ) {
    const only = parts[0] as { text?: string }
    return only.text ?? ""
  }
  return parts
}
