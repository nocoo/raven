/**
 * Phase E.3 — verify the new CopilotOpenAIClient emits the same on-wire
 * shape captured by the E.2 fixtures. Uses the default state-bound
 * config so the comparison is end-to-end vs. the legacy service.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { state } from "../../src/lib/state";
import {
  CopilotOpenAIClient,
  createDefaultCopilotOpenAIClient,
  type ChatCompletionsPayload,
  type CopilotOpenAIConfig,
} from "../../src/upstream/copilot-openai";
import { upstreamCharacterisations } from "./__characterisation__/upstream-fixtures";
import { bootstrap as sentinelBootstrap, type SentinelHandle } from "../../src/lib/token-sentinel";
import { _resetTokenSignalForTest, tokenSignal } from "../../src/lib/token-signal";

interface CapturedRequest {
  url: string;
  method: string;
  proxy: string | null;
  headers: Record<string, string>;
  body: unknown;
}

function normaliseHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : v;
    });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw)
      out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : v;
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] = k.toLowerCase() === "x-request-id" ? "<UUID>" : (v as string);
  }
  return out;
}

function captureFetch(): { spy: ReturnType<typeof vi.spyOn>; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit & { proxy?: string },
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyText = typeof init?.body === "string" ? init.body : "";
    captured.push({
      url,
      method: init?.method ?? "GET",
      proxy: init?.proxy ?? null,
      headers: normaliseHeaders(init?.headers),
      body: bodyText ? JSON.parse(bodyText) : null,
    });
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch);
  return { spy, captured };
}

const SAVED = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  copilotChatVersion: state.copilotChatVersion,
};

let spy: ReturnType<typeof vi.spyOn>;
let captured: CapturedRequest[];

beforeEach(() => {
  ({ spy, captured } = captureFetch());
});

afterEach(() => {
  spy.mockRestore();
  state.copilotToken = SAVED.copilotToken;
  state.vsCodeVersion = SAVED.vsCodeVersion;
  state.accountType = SAVED.accountType;
  state.copilotChatVersion = SAVED.copilotChatVersion;
});

function applyState(s: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(s)) {
    (state as unknown as Record<string, unknown>)[k] = v;
  }
}

function expectMatches(actual: CapturedRequest, fixtureId: string): void {
  const f = upstreamCharacterisations.find((e) => e.id === fixtureId)!;
  expect(actual.url).toBe(f.request.url);
  expect(actual.method).toBe(f.request.method);
  expect(actual.proxy).toBe(f.request.proxy);
  expect(actual.body).toEqual(f.request.body);
  const sortA = Object.fromEntries(
    Object.entries(actual.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sortE = Object.fromEntries(
    Object.entries(f.request.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  expect(sortA).toEqual(sortE);
}

describe("CopilotOpenAIClient (E.3)", () => {
  test("matches E.2 fixture: copilot-openai/non-stream", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-openai/non-stream")!;
    applyState(f.input.state);
    const client = createDefaultCopilotOpenAIClient();
    await client.send(f.input.payload as ChatCompletionsPayload);
    expectMatches(captured[0]!, f.id);
  });

  test("matches E.2 fixture: copilot-openai/agent-call", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-openai/agent-call")!;
    applyState(f.input.state);
    const client = createDefaultCopilotOpenAIClient();
    await client.send(f.input.payload as ChatCompletionsPayload);
    expectMatches(captured[0]!, f.id);
  });

  test("throws when token missing", async () => {
    state.copilotToken = null;
    const client = createDefaultCopilotOpenAIClient();
    await expect(
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("Copilot token not found");
    expect(captured).toHaveLength(0);
  });

  test("propagates HTTPError on non-2xx", async () => {
    spy.mockRestore();
    spy = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(
        new Response("server error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      )) as unknown as typeof fetch);
    state.copilotToken = "test-jwt";
    state.vsCodeVersion = "1.90.0";
    state.accountType = "individual";
    state.copilotChatVersion = "0.45.1";
    const client = createDefaultCopilotOpenAIClient();
    await expect(
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("Failed to create chat completions");
  });

  test("returns AsyncGenerator when payload.stream is true", async () => {
    spy.mockRestore();
    spy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"hello":"world"}\n\n'));
          c.close();
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    }) as unknown as typeof fetch);
    state.copilotToken = "test-jwt";
    state.vsCodeVersion = "1.90.0";
    state.accountType = "individual";
    state.copilotChatVersion = "0.45.1";
    const client = createDefaultCopilotOpenAIClient();
    const result = await client.send({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
      stream: true,
    });
    expect(typeof (result as AsyncGenerator<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  test("uses injected config (no state read)", async () => {
    const config: CopilotOpenAIConfig = {
      getToken: () => "injected-jwt",
      getBaseUrl: () => "https://inj.example.com",
      getHeaders: () => ({ "x-injected": "yes" }),
      getProxyUrl: () => "http://127.0.0.1:9999",
      snapshotAuth: ({ isAgentCall }) => ({
        token: "injected-jwt",
        headers: {
          "x-injected": "yes",
          "X-Initiator": isAgentCall ? "agent" : "user",
        },
      }),
    };
    const client = new CopilotOpenAIClient(config);
    await client.send({ model: "gpt", messages: [{ role: "user", content: "hi" }] });
    expect(captured[0]!.url).toBe("https://inj.example.com/chat/completions");
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999");
    expect(captured[0]!.headers["x-injected"]).toBe("yes");
    expect(captured[0]!.headers["x-initiator"]).toBe("user");
  });
});

// ===========================================================================
// 401 retry matrix (phase 2.4)
//
// End-to-end: real CopilotOpenAIClient + real sentinel + mocked fetch.
// Uses the actual getCopilotToken mock indirectly via fetch spy that returns
// the GitHub copilot_internal/v2/token shape.
// ===========================================================================

describe("CopilotOpenAIClient — 401 retry matrix", () => {
  let handle: SentinelHandle | null = null;

  beforeEach(() => {
    // captureFetch in outer beforeEach already mocked fetch; this block uses
    // bespoke mocks per test so restore first.
    spy.mockRestore();
    _resetTokenSignalForTest();
    state.copilotToken = "stale-jwt";
    state.vsCodeVersion = "1.117.0";
    state.copilotChatVersion = "0.45.1";
    state.accountType = "individual";
  });

  afterEach(() => {
    if (handle) {
      handle.stop();
      handle = null;
    }
    state.copilotToken = SAVED.copilotToken;
  });

  /**
   * Mock fetch to:
   *  - intercept /chat/completions: replay scripted responses in order
   *  - intercept /copilot_internal/v2/token: return given refresh result
   */
  function mockFetchScript(opts: {
    chatResponses: Response[];
    tokenRefresh?:
      | { ok: true; token: string; refresh_in?: number }
      | { ok: false; status: number; body: string };
  }): { fetchSpy: ReturnType<typeof vi.spyOn>; calls: { url: string; auth: string | null }[] } {
    const calls: { url: string; auth: string | null }[] = [];
    let chatIdx = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = normaliseHeaders(init?.headers);
      calls.push({ url, auth: headers.authorization ?? null });

      if (url.includes("/copilot_internal/v2/token")) {
        if (opts.tokenRefresh?.ok) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                token: opts.tokenRefresh.token,
                refresh_in: opts.tokenRefresh.refresh_in ?? 1500,
                expires_at: 9_999_999_999,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(opts.tokenRefresh!.body, { status: opts.tokenRefresh!.status }),
        );
      }
      if (url.includes("/chat/completions")) {
        const r = opts.chatResponses[chatIdx];
        if (!r) throw new Error(`unexpected chat call #${chatIdx + 1}`);
        chatIdx += 1;
        return Promise.resolve(r);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);
    return { fetchSpy, calls };
  }

  test("2xx: no signal report, no refreshNow", async () => {
    const { fetchSpy, calls } = mockFetchScript({
      chatResponses: [
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ],
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });

    const client = createDefaultCopilotOpenAIClient();
    await client.send({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] });

    expect(tokenSignal.readScore()).toBe(0);
    // Only one chat call, no token refresh
    expect(calls.filter((c) => c.url.includes("/chat/completions"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/copilot_internal/v2/token"))).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  test("401 non-token-expired: reports other-401, does NOT call refreshNow, throws", async () => {
    const { fetchSpy, calls } = mockFetchScript({
      chatResponses: [new Response("unauthorized: bad scope", { status: 401 })],
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });

    const client = createDefaultCopilotOpenAIClient();
    await expect(
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("Failed to create chat completions");

    expect(tokenSignal.readScore()).toBe(1); // other-401
    expect(calls.filter((c) => c.url.includes("/chat/completions"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/copilot_internal/v2/token"))).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  test("401 token-expired + refresh success + retry 2xx: returns retry response, single retry", async () => {
    const { fetchSpy, calls } = mockFetchScript({
      chatResponses: [
        new Response("token expired", { status: 401 }),
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ],
      tokenRefresh: { ok: true, token: "fresh-jwt" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    // Advance time past min-interval so refreshNow actually calls upstream
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotOpenAIClient();
    const result = await client.send({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result).toEqual({});

    const chatCalls = calls.filter((c) => c.url.includes("/chat/completions"));
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]!.auth).toBe("Bearer stale-jwt");
    expect(chatCalls[1]!.auth).toBe("Bearer fresh-jwt");
    expect(state.copilotToken).toBe("fresh-jwt");
    expect(tokenSignal.readScore()).toBe(3); // token-expired
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("401 token-expired + refresh failure: no retry, original 401 thrown", async () => {
    const { fetchSpy, calls } = mockFetchScript({
      chatResponses: [new Response("token expired", { status: 401 })],
      tokenRefresh: { ok: false, status: 500, body: "upstream down" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotOpenAIClient();
    await expect(
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("Failed to create chat completions");

    expect(calls.filter((c) => c.url.includes("/chat/completions"))).toHaveLength(1);
    expect(state.copilotToken).toBe("stale-jwt"); // unchanged
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("concurrent tail: A & B both use stale, B refreshes first → A short-circuits via attemptedToken", async () => {
    // Sequence:
    //   - A starts, snapshot token = "stale"
    //   - B starts, snapshot token = "stale"
    //   - A first call returns 401 token-expired → refreshNow("llm-401", "stale")
    //     → fetches /copilot_internal/v2/token → returns "fresh"
    //   - A retries with fresh, gets 200
    //   - B first call returns 401 token-expired → refreshNow("llm-401", "stale")
    //     → attemptedToken !== state.copilotToken (now "fresh") → short-circuit
    //   - B retries with fresh, gets 200
    let chatIdx = 0;
    const chatResponses: Response[] = [
      new Response("token expired", { status: 401 }), // A first
      new Response("token expired", { status: 401 }), // B first
      new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } }), // A retry
      new Response('{"b":2}', { status: 200, headers: { "content-type": "application/json" } }), // B retry
    ];
    let tokenCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/copilot_internal/v2/token")) {
        tokenCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: "fresh-jwt",
              refresh_in: 1500,
              expires_at: 9_999_999_999,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const r = chatResponses[chatIdx];
      if (!r) throw new Error(`unexpected chat call #${chatIdx + 1}`);
      chatIdx += 1;
      return Promise.resolve(r);
    }) as unknown as typeof fetch);

    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotOpenAIClient();
    const [rA, rB] = await Promise.all([
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "a" }] }),
      client.send({ model: "gpt-4o", messages: [{ role: "user", content: "b" }] }),
    ]);

    expect(rA).toEqual({ a: 1 });
    expect(rB).toEqual({ b: 2 });
    // Upstream token endpoint called at most once even with two concurrent retries
    expect(tokenCalls).toBeLessThanOrEqual(1);
    expect(state.copilotToken).toBe("fresh-jwt");
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });
});
