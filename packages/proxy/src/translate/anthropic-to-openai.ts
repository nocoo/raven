import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  OpenAIRequest,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolChoice,
  OpenAIToolCall,
  OpenAIContent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Model name normalization: strip trailing date suffix from Claude models
// e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4"
// ---------------------------------------------------------------------------

const CLAUDE_DATE_SUFFIX = /^(claude-.+)-(\d{8})$/;

function normalizeModel(model: string): string {
  const m = CLAUDE_DATE_SUFFIX.exec(model);
  return m ? m[1] : model;
}

// ---------------------------------------------------------------------------
// System prompt: string | TextBlock[] → single system message
// ---------------------------------------------------------------------------

function translateSystem(
  system: string | AnthropicTextBlock[] | undefined,
): OpenAIMessage | null {
  if (system === undefined) return null;
  if (typeof system === "string") {
    return { role: "system", content: system };
  }
  // TextBlock[]
  return {
    role: "system",
    content: system.map((b) => b.text).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

function translateMessages(
  messages: AnthropicRequest["messages"],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const msg of messages) {
    // String content — pass through directly
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Array content — need to inspect block types
    const blocks = msg.content;
    const hasToolResult = blocks.some((b) => b.type === "tool_result");
    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    const hasImage = blocks.some((b) => b.type === "image");

    if (hasToolResult) {
      // Split: each tool_result → tool message, remaining text → user message
      translateToolResultBlocks(blocks, out);
    } else if (hasToolUse) {
      // Assistant message with tool_calls
      translateToolUseBlocks(msg.role, blocks, out);
    } else if (hasImage) {
      // User message with images — keep as array content
      translateImageBlocks(msg.role, blocks, out);
    } else {
      // Pure text + thinking blocks — merge to string
      const text = mergeTextAndThinking(blocks);
      out.push({ role: msg.role, content: text });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tool result blocks → tool messages
// ---------------------------------------------------------------------------

function translateToolResultBlocks(
  blocks: AnthropicContentBlock[],
  out: OpenAIMessage[],
): void {
  for (const block of blocks) {
    if (block.type === "tool_result") {
      const tr = block as AnthropicToolResultBlock;
      const content =
        typeof tr.content === "string"
          ? tr.content
          : (tr.content as AnthropicContentBlock[])
              .filter((b): b is AnthropicTextBlock => b.type === "text")
              .map((b) => b.text)
              .join("\n");
      out.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content,
      });
    } else if (block.type === "text") {
      out.push({ role: "user", content: (block as AnthropicTextBlock).text });
    }
  }
}

// ---------------------------------------------------------------------------
// Tool use blocks → assistant message with tool_calls
// ---------------------------------------------------------------------------

function translateToolUseBlocks(
  _role: "user" | "assistant",
  blocks: AnthropicContentBlock[],
  out: OpenAIMessage[],
): void {
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use") {
      const tu = block as AnthropicToolUseBlock;
      toolCalls.push({
        id: tu.id,
        type: "function",
        function: {
          name: tu.name,
          arguments: JSON.stringify(tu.input),
        },
      });
    } else if (block.type === "text") {
      textParts.push((block as AnthropicTextBlock).text);
    } else if (block.type === "thinking") {
      textParts.push((block as AnthropicThinkingBlock).thinking);
    }
  }

  const msg: OpenAIMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n") : null,
    tool_calls: toolCalls,
  };
  out.push(msg);
}

// ---------------------------------------------------------------------------
// Image blocks → array content with image_url
// ---------------------------------------------------------------------------

function translateImageBlocks(
  role: "user" | "assistant",
  blocks: AnthropicContentBlock[],
  out: OpenAIMessage[],
): void {
  const content: OpenAIContent = [];

  for (const block of blocks) {
    if (block.type === "image") {
      const img = block as AnthropicImageBlock;
      (content as Array<{ type: string; image_url: { url: string } }>).push({
        type: "image_url",
        image_url: {
          url: `data:${img.source.media_type};base64,${img.source.data}`,
        },
      });
    } else if (block.type === "text") {
      (content as Array<{ type: string; text: string }>).push({
        type: "text",
        text: (block as AnthropicTextBlock).text,
      });
    }
  }

  out.push({ role, content: content as OpenAIMessage["content"] });
}

// ---------------------------------------------------------------------------
// Merge text + thinking blocks into a single string
// ---------------------------------------------------------------------------

function mergeTextAndThinking(blocks: AnthropicContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return (b as AnthropicTextBlock).text;
      if (b.type === "thinking") return (b as AnthropicThinkingBlock).thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tools translation
// ---------------------------------------------------------------------------

function translateTools(
  tools: AnthropicRequest["tools"],
): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Tool choice translation
// ---------------------------------------------------------------------------

function translateToolChoice(
  choice: AnthropicRequest["tool_choice"],
): OpenAIToolChoice | undefined {
  if (!choice) return undefined;

  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name! } };
    default:
      return "auto";
  }
}

// ===========================================================================
// Main: translateRequest
// ===========================================================================

export function translateRequest(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // System prompt
  const systemMsg = translateSystem(req.system);
  if (systemMsg) messages.push(systemMsg);

  // Messages
  messages.push(...translateMessages(req.messages));

  const result: OpenAIRequest = {
    model: normalizeModel(req.model),
    messages,
    max_tokens: req.max_tokens,
  };

  // Optional fields
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.stream !== undefined) result.stream = req.stream;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stop_sequences) result.stop = req.stop_sequences;

  const tools = translateTools(req.tools);
  if (tools) result.tools = tools;

  const toolChoice = translateToolChoice(req.tool_choice);
  if (toolChoice !== undefined) result.tool_choice = toolChoice;

  return result;
}
