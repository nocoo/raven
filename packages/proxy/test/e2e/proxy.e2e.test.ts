/**
 * E2E tests for Raven proxy.
 *
 * Prerequisites: proxy must be running on localhost:7033
 *   cd packages/proxy && bun run dev
 *
 * Anti-ban protocol:
 * - Fail fast: abort suite on first upstream error
 * - Minimal requests: each test sends exactly 1 request
 * - No retries, no loops, no load testing
 */

import { describe, test, expect, beforeAll } from "bun:test";

const PROXY = process.env.RAVEN_PROXY_URL ?? "http://localhost:7033";
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

// ---------------------------------------------------------------------------
// Health & models
// ---------------------------------------------------------------------------

describe("e2e: health", () => {
  test("GET /health returns ok", async () => {
    if (!proxyReachable) return;

    const res = await fetch(`${PROXY}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("e2e: models", () => {
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

// ---------------------------------------------------------------------------
// Anthropic format — non-streaming
// ---------------------------------------------------------------------------

describe("e2e: /v1/messages (non-streaming)", () => {
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

    // Fail fast on upstream error
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Upstream error ${res.status} — aborting e2e suite to avoid ban.\n${body.slice(0, 200)}`,
      );
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

// ---------------------------------------------------------------------------
// OpenAI format — non-streaming
// ---------------------------------------------------------------------------

describe("e2e: /v1/chat/completions (non-streaming)", () => {
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
      const body = await res.text();
      throw new Error(
        `Upstream error ${res.status} — aborting e2e suite to avoid ban.\n${body.slice(0, 200)}`,
      );
    }

    const body = await res.json();

    // Validate OpenAI response shape
    // Note: Copilot API may omit "object" field unlike standard OpenAI
    expect(body.id).toBeDefined();
    expect(body.choices).toBeArray();
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(typeof body.choices[0].message.content).toBe("string");
    expect(body.choices[0].finish_reason).toBeDefined();
    expect(body.usage).toBeDefined();
  });
});
