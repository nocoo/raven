import { buildCopilotHeaders } from "./headers.ts";

const COPILOT_API_BASE = "https://api.githubcopilot.com";

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  [key: string]: unknown;
}

export interface CopilotClient {
  chatCompletion(
    request: ChatCompletionRequest,
    copilotJwt: string,
  ): Promise<Response>;
  createEmbedding(
    request: EmbeddingRequest,
    copilotJwt: string,
  ): Promise<Response>;
  fetchModels(copilotJwt: string): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Message introspection helpers
// ---------------------------------------------------------------------------

/**
 * Detect if any message contains image_url content parts.
 */
function hasVisionContent(messages: ChatCompletionRequest["messages"]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as Array<{ type?: string }>) {
      if (part.type === "image_url") return true;
    }
  }
  return false;
}

/**
 * Detect if conversation involves agent-style interaction
 * (has assistant or tool messages beyond the initial turn).
 */
function isAgentConversation(
  messages: ChatCompletionRequest["messages"],
): boolean {
  return messages.some(
    (msg) => msg.role === "assistant" || msg.role === "tool",
  );
}

/**
 * Create a client that forwards requests to the GitHub Copilot API.
 */
export function createCopilotClient(
  fetchFn: typeof fetch = globalThis.fetch,
): CopilotClient {
  return {
    async chatCompletion(
      request: ChatCompletionRequest,
      copilotJwt: string,
    ): Promise<Response> {
      const headers = buildCopilotHeaders(copilotJwt);

      // Vision: signal Copilot that the request contains images
      if (hasVisionContent(request.messages)) {
        headers["copilot-vision-request"] = "true";
      }

      // Initiator: helps Copilot apply correct rate-limit tier
      headers["x-initiator"] = isAgentConversation(request.messages)
        ? "agent"
        : "user";

      const res = await fetchFn(`${COPILOT_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      return res;
    },

    async createEmbedding(
      request: EmbeddingRequest,
      copilotJwt: string,
    ): Promise<Response> {
      const headers = buildCopilotHeaders(copilotJwt);

      return fetchFn(`${COPILOT_API_BASE}/embeddings`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
    },

    async fetchModels(copilotJwt: string): Promise<Response> {
      const headers = buildCopilotHeaders(copilotJwt);

      return fetchFn(`${COPILOT_API_BASE}/models`, {
        headers,
      });
    },
  };
}
