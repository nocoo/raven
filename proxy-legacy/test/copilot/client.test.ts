import { describe, expect, test, mock } from "bun:test";

describe("Copilot Client", () => {
  test("proxies chat completion request to Copilot API", async () => {
    const { createCopilotClient } = await import("../../src/copilot/client.ts");

    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello!" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const client = createCopilotClient(mockFetch as unknown as typeof fetch);

    const result = await client.chatCompletion(
      {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "Hello" }],
      },
      "copilot-jwt-token",
    );

    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("Hello!");

    // Verify it called the Copilot API
    const call = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("api.githubcopilot.com");
  });

  test("proxies streaming request", async () => {
    const { createCopilotClient } = await import("../../src/copilot/client.ts");

    const sseData =
      'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';

    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(sseData, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    );

    const client = createCopilotClient(mockFetch as unknown as typeof fetch);

    const result = await client.chatCompletion(
      {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      },
      "copilot-jwt-token",
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toContain("text/event-stream");
  });

  test("forwards error responses from upstream", async () => {
    const { createCopilotClient } = await import("../../src/copilot/client.ts");

    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      ),
    );

    const client = createCopilotClient(mockFetch as unknown as typeof fetch);

    const result = await client.chatCompletion(
      { model: "gpt-4", messages: [] },
      "jwt",
    );

    expect(result.status).toBe(429);
  });
});
