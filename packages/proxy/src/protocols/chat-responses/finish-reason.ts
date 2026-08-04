import type { ChatFinishReason } from "./types"

export function mapResponsesFinishReason(body: {
  status?: unknown
  incomplete_details?: { reason?: unknown } | null
  output?: unknown
}): ChatFinishReason {
  const output = Array.isArray(body.output) ? body.output : []
  const hasToolCall = output.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "function_call",
  )
  if (hasToolCall) return "tool_calls"

  if (body.status === "incomplete") {
    const reason = body.incomplete_details?.reason
    const reasonStr = typeof reason === "string" ? reason.toLowerCase() : ""
    if (
      reasonStr.includes("max_output_tokens") ||
      reasonStr.includes("max_tokens") ||
      reasonStr === "length"
    ) {
      return "length"
    }
    if (reasonStr.includes("content_filter")) {
      return "content_filter"
    }
  }

  return "stop"
}
