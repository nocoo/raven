/**
 * E2E tests for Raven proxy.
 *
 * Prerequisites: proxy must be running on localhost:7024
 *   cd packages/proxy && bun run dev
 *
 * Anti-ban protocol:
 * - Fail fast: abort suite on first upstream error
 * - Minimal requests: each test sends exactly 1 request
 * - No retries, no loops, no load testing
 *
 * Test layers (orthogonal concerns):
 *   Layer 1: Protocol conformance — response shapes match OpenAI/Anthropic specs
 *   Layer 2: Streaming translation — SSE event sequences are correct
 *   Layer 3: Feature parity — newly added endpoints work
 *   Layer 4: Regression guard — historical bugs stay fixed
 */

import { describe, test, expect, beforeAll } from "bun:test";

const PROXY = process.env.RAVEN_PROXY_URL ?? "http://localhost:7024";
const API_KEY = process.env.RAVEN_API_KEY ?? "";

// Headers for authenticated requests
function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (API_KEY) {
    h["Authorization"] = `Bearer ${API_KEY}`;
  }
  return h;
}

/**
 * Fail-fast helper: throw on non-2xx to abort suite and avoid ban.
 */
function failFastOnError(res: Response, body: string): void {
  if (!res.ok) {
    throw new Error(
      `Upstream error ${res.status} — aborting e2e suite to avoid ban.\n${body.slice(0, 200)}`,
    );
  }
}

/**
 * Parse an SSE stream into an array of event objects.
 * Each event has { event?: string, data: string }.
 */
async function consumeSSE(
  res: Response,
): Promise<Array<{ event?: string; data: string }>> {
  const text = await res.text();
  const events: Array<{ event?: string; data: string }> = [];

  let currentEvent: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (currentEvent !== undefined) {
        events.push({ event: currentEvent, data });
      } else {
        events.push({ data });
      }
      currentEvent = undefined;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Connectivity check — skip everything if proxy is down
// ---------------------------------------------------------------------------

let proxyReachable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(3000) });
    proxyReachable = res.ok;
  } catch {
    proxyReachable = false;
  }

  if (!proxyReachable) {
    console.warn("\n⚠️  Proxy not reachable at %s — skipping e2e tests\n", PROXY);
  }
});

// ===========================================================================
// Layer 1: Protocol Conformance
// ===========================================================================

describe("e2e L1: health", () => {
  test("GET /health returns ok", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("e2e L1: models", () => {
  test("GET /v1/models returns model list", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/v1/models`, { headers: headers() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBeDefined();
    expect(body.data[0].object).toBe("model");
  });
});

describe("e2e L1: /v1/messages (non-streaming)", () => {
  test("Claude Haiku 4.5 returns valid Anthropic response", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly: hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      failFastOnError(res, await res.text());
    }

    const body = await res.json();

    // Validate Anthropic response shape
    expect(body.id).toBeDefined();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toBeArray();
    expect(body.content.length).toBeGreaterThan(0);
    expect(body.content[0].type).toBe("text");
    expect(typeof body.content[0].text).toBe("string");
    expect(body.stop_reason).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(typeof body.usage.input_tokens).toBe("number");
    expect(typeof body.usage.output_tokens).toBe("number");
  });
});

describe("e2e L1: /v1/chat/completions (non-streaming)", () => {
  test("GPT-5-mini returns valid OpenAI response", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly: hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      failFastOnError(res, await res.text());
    }

    const body = await res.json();

    expect(body.id).toBeDefined();
    expect(body.choices).toBeArray();
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(typeof body.choices[0].message.content).toBe("string");
    expect(body.choices[0].finish_reason).toBeDefined();
    expect(body.usage).toBeDefined();
  });
});

// ===========================================================================
// Layer 2: Streaming Translation
// ===========================================================================

describe("e2e L2: /v1/messages (streaming)", () => {
  test("Anthropic SSE event lifecycle is correct", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 32,
        stream: true,
        messages: [
          { role: "user", content: "Reply with exactly one word: hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      failFastOnError(res, await res.text());
    }

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await consumeSSE(res);
    const eventTypes = events
      .filter((e) => e.event) // only named events
      .map((e) => e.event);

    // Verify the Anthropic SSE lifecycle
    expect(eventTypes[0]).toBe("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes[eventTypes.length - 1]).toBe("message_stop");

    // Verify message_start contains usage with input_tokens
    const messageStart = events.find((e) => e.event === "message_start");
    expect(messageStart).toBeDefined();
    const startData = JSON.parse(messageStart!.data);
    expect(startData.message.usage).toBeDefined();
    expect(typeof startData.message.usage.input_tokens).toBe("number");

    // Verify message_delta contains complete usage
    const messageDelta = events.find((e) => e.event === "message_delta");
    expect(messageDelta).toBeDefined();
    const deltaData = JSON.parse(messageDelta!.data);
    expect(deltaData.delta.stop_reason).toBeDefined();
    expect(typeof deltaData.usage.output_tokens).toBe("number");
    // Gap #7 fix: input_tokens should be present in message_delta
    expect(typeof deltaData.usage.input_tokens).toBe("number");
  });
});

describe("e2e L2: /v1/chat/completions (streaming)", () => {
  test("OpenAI SSE chunks are well-formed", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 32,
        stream: true,
        messages: [
          { role: "user", content: "Reply with exactly one word: hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      failFastOnError(res, await res.text());
    }

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await consumeSSE(res);

    // Should have at least one data chunk and end with [DONE]
    expect(events.length).toBeGreaterThan(1);
    expect(events[events.length - 1]!.data).toBe("[DONE]");

    // At least one chunk should have model field
    const dataChunks = events
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data));
    const hasModel = dataChunks.some((c: { model?: string }) => c.model);
    expect(hasModel).toBe(true);
    expect(dataChunks[0].choices).toBeArray();
  });
});

// ===========================================================================
// Layer 3: Feature Parity (gap verification)
// ===========================================================================

describe("e2e L3: /v1/messages/count_tokens", () => {
  test("returns token count without hitting upstream", async () => {
    if (!proxyReachable) return;

    // This endpoint is local-only — no upstream request needed
    const res = await fetch(`${PROXY}/v1/messages/count_tokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Hello, how are you?" },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.input_tokens).toBe("number");
    expect(body.input_tokens).toBeGreaterThan(0);
  });
});

describe("e2e L3: no-prefix routes", () => {
  test("POST /chat/completions works without /v1 prefix", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_tokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly: hello" },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      failFastOnError(res, await res.text());
    }

    const body = await res.json();
    expect(body.choices).toBeArray();
    expect(body.choices[0].message.content).toBeDefined();
  });
});

// ===========================================================================
// Layer 4: Regression Guard
// ===========================================================================

describe("e2e L4: tool_choice none", () => {
  test("tool_choice none prevents tool use in response", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: "What is 2+2? Use the calculator tool to find the answer.",
          },
        ],
        tools: [
          {
            name: "calculator",
            description: "Performs arithmetic calculations",
            input_schema: {
              type: "object",
              properties: {
                expression: {
                  type: "string",
                  description: "The math expression to evaluate",
                },
              },
              required: ["expression"],
            },
          },
        ],
        tool_choice: { type: "none" },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      failFastOnError(res, await res.text());
    }

    const body = await res.json();

    // With tool_choice: none, the model should NOT use tools
    expect(body.content).toBeArray();
    const hasToolUse = body.content.some(
      (block: { type: string }) => block.type === "tool_use",
    );
    expect(hasToolUse).toBe(false);
  });
});
