import { Hono } from "hono";
import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicImageBlock,
} from "../translate/types.ts";

// ---------------------------------------------------------------------------
// Character-based token estimation
// ---------------------------------------------------------------------------

// Average characters per token varies by model family, but ~4 is the
// industry-standard approximation for English text with GPT-style tokenizers.
const CHARS_PER_TOKEN = 4;

// Per-message overhead: <|role|> framing tokens
const TOKENS_PER_MESSAGE = 3;

// Reply priming: <|start|>assistant<|message|>
const REPLY_PRIMING_TOKENS = 3;

// Tool definition overhead for Claude models (Anthropic pricing docs)
const CLAUDE_TOOL_OVERHEAD = 346;

// Correction factor: Claude models tend to use ~15% more tokens than GPT estimates
const CLAUDE_CORRECTION = 1.15;

// ---------------------------------------------------------------------------
// Extract text from Anthropic content blocks
// ---------------------------------------------------------------------------

function extractText(
  content: string | AnthropicContentBlock[],
): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push((block as AnthropicTextBlock).text);
        break;
      case "thinking":
        parts.push((block as AnthropicThinkingBlock).thinking);
        break;
      case "tool_use": {
        const tu = block as AnthropicToolUseBlock;
        parts.push(tu.name);
        parts.push(JSON.stringify(tu.input));
        break;
      }
      case "tool_result": {
        const tr = block as AnthropicToolResultBlock;
        if (typeof tr.content === "string") {
          parts.push(tr.content);
        } else if (Array.isArray(tr.content)) {
          parts.push(extractText(tr.content));
        }
        break;
      }
      case "image": {
        // Image tokens are hard to estimate without knowing dimensions.
        // Use a conservative fixed estimate similar to OpenAI's low-detail mode.
        const img = block as AnthropicImageBlock;
        parts.push(img.source.data.slice(0, 100)); // partial for estimation
        break;
      }
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Estimate tokens from an Anthropic request
// ---------------------------------------------------------------------------

function estimateTokens(req: AnthropicRequest): number {
  let chars = 0;

  // System prompt
  if (req.system) {
    if (typeof req.system === "string") {
      chars += req.system.length;
    } else {
      chars += req.system.map((b) => b.text).join("\n").length;
    }
    chars += TOKENS_PER_MESSAGE * CHARS_PER_TOKEN; // system message framing
  }

  // Messages
  for (const msg of req.messages) {
    chars += TOKENS_PER_MESSAGE * CHARS_PER_TOKEN; // framing
    chars += msg.role.length;
    chars += extractText(msg.content).length;
  }

  // Reply priming
  chars += REPLY_PRIMING_TOKENS * CHARS_PER_TOKEN;

  let tokens = Math.ceil(chars / CHARS_PER_TOKEN);

  // Tool definitions
  if (req.tools && req.tools.length > 0) {
    let toolChars = 0;
    for (const tool of req.tools) {
      toolChars += tool.name.length;
      toolChars += (tool.description ?? "").length;
      toolChars += JSON.stringify(tool.input_schema).length;
    }
    tokens += Math.ceil(toolChars / CHARS_PER_TOKEN);

    // Claude tool overhead (skip for MCP tools)
    const hasMcpTools = req.tools.some((t) => t.name.startsWith("mcp__"));
    if (!hasMcpTools && req.model.startsWith("claude")) {
      tokens += CLAUDE_TOOL_OVERHEAD;
    }
  }

  // Claude correction factor
  if (req.model.startsWith("claude")) {
    tokens = Math.round(tokens * CLAUDE_CORRECTION);
  }

  return tokens;
}

// ===========================================================================
// Route
// ===========================================================================

export const countTokensRoute = new Hono();

countTokensRoute.post("/messages/count_tokens", async (c) => {
  try {
    const body = (await c.req.json()) as AnthropicRequest;
    const inputTokens = estimateTokens(body);
    return c.json({ input_tokens: inputTokens });
  } catch {
    // Graceful fallback — never break the client
    return c.json({ input_tokens: 1 });
  }
});
