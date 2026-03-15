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

export interface CopilotClient {
  chatCompletion(
    request: ChatCompletionRequest,
    copilotJwt: string,
  ): Promise<Response>;
  fetchModels(copilotJwt: string): Promise<Response>;
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

    async fetchModels(copilotJwt: string): Promise<Response> {
      const headers = buildCopilotHeaders(copilotJwt);

      return fetchFn(`${COPILOT_API_BASE}/models`, {
        headers,
      });
    },
  };
}
