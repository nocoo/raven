/**
 * Phase E.5 — verify CopilotResponsesClient against E.2 fixture.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { state } from "../../src/lib/state";
import {
  CopilotResponsesClient,
  createDefaultCopilotResponsesClient,
  type ResponsesPayload,
} from "../../src/upstream/copilot-responses";
import { upstreamCharacterisations } from "./__characterisation__/upstream-fixtures";
import {
  bootstrap as sentinelBootstrap,
  refreshNow,
  _debugSnapshot,
  type SentinelHandle,
} from "../../src/lib/token-sentinel";
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
  }) as unknown as typeof fetch);
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

describe("CopilotResponsesClient (E.5)", () => {
  test("matches E.2 fixture: copilot-responses/basic", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-responses/basic")!;
    applyState(f.input.state);
    const client = createDefaultCopilotResponsesClient();
    await client.send(f.input.payload as ResponsesPayload);
    expect(captured[0]!.url).toBe(f.request.url);
    expect(captured[0]!.body).toEqual(f.request.body);
    const sortA = Object.fromEntries(
      Object.entries(captured[0]!.headers).sort(([a], [b]) => a.localeCompare(b)),
    );
    const sortE = Object.fromEntries(
      Object.entries(f.request.headers).sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(sortA).toEqual(sortE);
  });

  test("throws when token missing", async () => {
    state.copilotToken = null;
    const client = createDefaultCopilotResponsesClient();
    await expect(client.send({ model: "gpt-5", input: "hi" })).rejects.toThrow(
      "Copilot token not found",
    );
  });

  test("propagates HTTPError on non-2xx", async () => {
    spy.mockRestore();
    spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((() =>
        Promise.resolve(new Response("err", { status: 500 }))) as unknown as typeof fetch);
    state.copilotToken = "test-jwt";
    state.vsCodeVersion = "1.90.0";
    state.accountType = "individual";
    state.copilotChatVersion = "0.45.1";
    const client = createDefaultCopilotResponsesClient();
    await expect(client.send({ model: "gpt-5", input: "hi" })).rejects.toThrow(
      "Failed to create responses",
    );
  });

  test("uses injected config", async () => {
    const client = new CopilotResponsesClient({
      getToken: () => "inj",
      getBaseUrl: () => "https://inj.example.com",
      getHeaders: () => ({ "x-injected": "yes" }),
      getProxyUrl: () => "http://127.0.0.1:9999",
      snapshotAuth: ({ isAgentCall }) => ({
        token: "inj",
        headers: {
          "x-injected": "yes",
          "X-Initiator": isAgentCall ? "agent" : "user",
        },
      }),
    });
    await client.send({ model: "gpt-5", input: "hi" });
    expect(captured[0]!.url).toBe("https://inj.example.com/responses");
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999");
    expect(captured[0]!.headers["x-injected"]).toBe("yes");
    expect(captured[0]!.headers["x-initiator"]).toBe("user");
  });

  test("stamps X-Initiator: agent for assistant history", async () => {
    state.copilotToken = "test-jwt";
    state.vsCodeVersion = "1.90.0";
    state.accountType = "individual";
    state.copilotChatVersion = "0.45.1";
    const client = createDefaultCopilotResponsesClient();
    await client.send({
      model: "gpt-5",
      input: [
        { role: "user", content: "?" },
        { role: "assistant", content: "ok" },
      ],
    });
    expect(captured[0]!.headers["x-initiator"]).toBe("agent");
  });

  test("flags vision when input_image present", async () => {
    state.copilotToken = "test-jwt";
    state.vsCodeVersion = "1.90.0";
    state.accountType = "individual";
    state.copilotChatVersion = "0.45.1";
    const client = createDefaultCopilotResponsesClient();
    await client.send({
      model: "gpt-5",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,abc" }],
        },
      ],
    });
    expect(captured[0]!.headers["copilot-vision-request"]).toBe("true");
  });
});

// ===========================================================================
// 401 retry matrix (phase 2.4)
// ===========================================================================

describe("CopilotResponsesClient — 401 retry matrix", () => {
  let handle: SentinelHandle | null = null;

  beforeEach(() => {
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
  });

  function mockScript(opts: {
    responses: Response[];
    tokenRefresh?: { ok: true; token: string } | { ok: false; status: number; body: string };
  }): ReturnType<typeof vi.spyOn> {
    let idx = 0;
    return vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/copilot_internal/v2/token")) {
        if (opts.tokenRefresh?.ok) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                token: opts.tokenRefresh.token,
                refresh_in: 1500,
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
      if (url.endsWith("/responses")) {
        const r = opts.responses[idx];
        if (!r) throw new Error(`unexpected /responses call #${idx + 1}`);
        idx += 1;
        return Promise.resolve(r);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);
  }

  test("401 token-expired + refresh success: retries once", async () => {
    const fetchSpy = mockScript({
      responses: [
        new Response("token expired", { status: 401 }),
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ],
      tokenRefresh: { ok: true, token: "fresh-jwt" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotResponsesClient();
    await client.send({ model: "gpt-5", input: "hi" });
    expect(state.copilotToken).toBe("fresh-jwt");
    expect(tokenSignal.readScore()).toBe(3);

    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("401 non-token-expired: throws without refreshNow", async () => {
    const fetchSpy = mockScript({
      responses: [new Response("forbidden", { status: 401 })],
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });

    const client = createDefaultCopilotResponsesClient();
    await expect(client.send({ model: "gpt-5", input: "hi" })).rejects.toThrow(
      "Failed to create responses",
    );
    expect(state.copilotToken).toBe("stale-jwt");
    expect(tokenSignal.readScore()).toBe(1);
    fetchSpy.mockRestore();
  });

  test("401 token-expired + refresh FAILURE: no retry, original 401 thrown", async () => {
    const fetchSpy = mockScript({
      responses: [new Response("token expired", { status: 401 })],
      tokenRefresh: { ok: false, status: 500, body: "upstream down" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotResponsesClient();
    await expect(client.send({ model: "gpt-5", input: "hi" })).rejects.toThrow(
      "Failed to create responses",
    );
    expect(state.copilotToken).toBe("stale-jwt");
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("401 token-expired + cooldown active: no retry", async () => {
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const firstSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((() =>
        Promise.resolve(new Response("fail", { status: 500 }))) as unknown as typeof fetch);
    await refreshNow("llm-401");
    firstSpy.mockRestore();
    expect(_debugSnapshot().cooldownRemaining).toBeGreaterThan(0);

    const fetchSpy = mockScript({
      responses: [new Response("token expired", { status: 401 })],
    });
    const client = createDefaultCopilotResponsesClient();
    await expect(client.send({ model: "gpt-5", input: "hi" })).rejects.toThrow(
      "Failed to create responses",
    );
    expect(state.copilotToken).toBe("stale-jwt");
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("401 token-expired + tokenWasUpdated=false (min-interval): no retry", async () => {
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    const fetchSpy = mockScript({
      responses: [new Response("token expired", { status: 401 })],
    });
    const client = createDefaultCopilotResponsesClient();
    await expect(client.send({ model: "gpt-5", input: "hi" })).rejects.toThrow(
      "Failed to create responses",
    );
    expect(state.copilotToken).toBe("stale-jwt");
    fetchSpy.mockRestore();
  });

  test("401 retry STILL 401: throws retry response error, no further refresh", async () => {
    const fetchSpy = mockScript({
      responses: [
        new Response("token expired", { status: 401 }),
        new Response("token expired again", { status: 401 }),
      ],
      tokenRefresh: { ok: true, token: "fresh-jwt" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotResponsesClient();
    await expect(client.send({ model: "gpt-5", input: "hi" })).rejects.toThrow(
      "Failed to create responses",
    );
    expect(state.copilotToken).toBe("fresh-jwt");
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("concurrent tail: A & B both stale, B refreshes first → A short-circuits", async () => {
    let idx = 0;
    const responses: Response[] = [
      new Response("token expired", { status: 401 }),
      new Response("token expired", { status: 401 }),
      new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } }),
      new Response('{"ok":2}', { status: 200, headers: { "content-type": "application/json" } }),
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
      const r = responses[idx];
      if (!r) throw new Error(`unexpected call #${idx + 1}`);
      idx += 1;
      return Promise.resolve(r);
    }) as unknown as typeof fetch);

    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotResponsesClient();
    const [rA, rB] = await Promise.all([
      client.send({ model: "gpt-5", input: "a" }),
      client.send({ model: "gpt-5", input: "b" }),
    ]);
    expect(rA).toBeTruthy();
    expect(rB).toBeTruthy();
    expect(tokenCalls).toBeLessThanOrEqual(1);
    expect(state.copilotToken).toBe("fresh-jwt");
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("snapshotAuth fixture parity: retry headers carry Authorization + X-Initiator", async () => {
    const calls: { url: string; auth: string | null; xInitiator: string | null }[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const h = normaliseHeaders(init?.headers);
      calls.push({
        url,
        auth: h.authorization ?? null,
        xInitiator: h["x-initiator"] ?? null,
      });
      if (url.includes("/copilot_internal/v2/token")) {
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
      const respCalls = calls.filter((c) => c.url.endsWith("/responses")).length;
      if (respCalls === 1) return Promise.resolve(new Response("token expired", { status: 401 }));
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as unknown as typeof fetch);

    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotResponsesClient();
    await client.send({ model: "gpt-5", input: "hi" });

    const respCalls = calls.filter((c) => c.url.endsWith("/responses"));
    expect(respCalls).toHaveLength(2);
    expect(respCalls[0]!.auth).toBe("Bearer stale-jwt");
    expect(respCalls[0]!.xInitiator).toBe("user");
    expect(respCalls[1]!.auth).toBe("Bearer fresh-jwt");
    expect(respCalls[1]!.xInitiator).toBe("user");

    vi.useRealTimers();
    fetchSpy.mockRestore();
  });
});
