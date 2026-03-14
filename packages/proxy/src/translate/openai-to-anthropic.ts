import type {
  AnthropicResponse,
  AnthropicContentBlock,
  OpenAIResponse,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Stop reason mapping: OpenAI → Anthropic
// ---------------------------------------------------------------------------

function translateStopReason(
  finishReason: string | null,
): AnthropicResponse["stop_reason"] {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Usage mapping: OpenAI → Anthropic
// ---------------------------------------------------------------------------

function translateUsage(
  usage: OpenAIResponse["usage"] | undefined,
): AnthropicResponse["usage"] {
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0 };
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    input_tokens: usage.prompt_tokens - cachedTokens,
    output_tokens: usage.completion_tokens,
    ...(cachedTokens > 0 && { cache_read_input_tokens: cachedTokens }),
  };
}

// ---------------------------------------------------------------------------
// Content translation: OpenAI message → Anthropic content blocks
// ---------------------------------------------------------------------------

function translateContent(
  message: OpenAIResponse["choices"][0]["message"],
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  // Text content
  if (message.content) {
    blocks.push({ type: "text", text: message.content });
  }

  // Tool calls → tool_use blocks
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  return blocks;
}

// ===========================================================================
// Main: translateResponse
// ===========================================================================

export function translateResponse(res: OpenAIResponse): AnthropicResponse {
  const choice = res.choices[0];

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    content: translateContent(choice.message),
    model: res.model,
    stop_reason: translateStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: translateUsage(res.usage),
  };
}
