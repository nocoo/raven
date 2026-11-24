/**
 * Phase E.6 — verify CopilotEmbeddingsClient against E.2 fixture.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { state } from "../../src/lib/state";
import {
  CopilotEmbeddingsClient,
  createDefaultCopilotEmbeddingsClient,
  type EmbeddingRequest,
} from "../../src/upstream/copilot-embeddings";
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
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
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

describe("CopilotEmbeddingsClient (E.6)", () => {
  test("matches E.2 fixture: copilot-embeddings/basic", async () => {
    const f = upstreamCharacterisations.find((e) => e.id === "copilot-embeddings/basic")!;
    applyState(f.input.state);
    const client = createDefaultCopilotEmbeddingsClient();
    await client.send(f.input.payload as EmbeddingRequest);
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
    const client = createDefaultCopilotEmbeddingsClient();
    await expect(client.send({ input: "x", model: "m" })).rejects.toThrow(
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
    const client = createDefaultCopilotEmbeddingsClient();
    await expect(client.send({ input: "x", model: "m" })).rejects.toThrow(
      "Failed to create embeddings",
    );
  });

  test("uses injected config", async () => {
    const client = new CopilotEmbeddingsClient({
      getToken: () => "inj",
      getBaseUrl: () => "https://inj.example.com",
      getHeaders: () => ({ "x-injected": "yes" }),
      getProxyUrl: () => "http://127.0.0.1:9999",
      snapshotAuth: () => ({
        token: "inj",
        headers: { "x-injected": "yes" },
      }),
    });
    await client.send({ input: "x", model: "m" });
    expect(captured[0]!.url).toBe("https://inj.example.com/embeddings");
    expect(captured[0]!.proxy).toBe("http://127.0.0.1:9999");
    expect(captured[0]!.headers["x-injected"]).toBe("yes");
  });
});

// ===========================================================================
// 401 retry matrix (phase 2.4)
// ===========================================================================

describe("CopilotEmbeddingsClient — 401 retry matrix", () => {
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
      if (url.endsWith("/embeddings")) {
        const r = opts.responses[idx];
        if (!r) throw new Error(`unexpected /embeddings call #${idx + 1}`);
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
        new Response(
          JSON.stringify({
            object: "list",
            data: [],
            model: "m",
            usage: { prompt_tokens: 0, total_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ],
      tokenRefresh: { ok: true, token: "fresh-jwt" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotEmbeddingsClient();
    const r = await client.send({ input: "hi", model: "m" });
    expect((r as { object: string }).object).toBe("list");
    expect(state.copilotToken).toBe("fresh-jwt");
    expect(tokenSignal.readScore()).toBe(3);

    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("401 non-token-expired: throws without refreshNow", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((() =>
        Promise.resolve(new Response("forbidden", { status: 401 }))) as unknown as typeof fetch);
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });

    const client = createDefaultCopilotEmbeddingsClient();
    await expect(client.send({ input: "hi", model: "m" })).rejects.toThrow(
      "Failed to create embeddings",
    );
    expect(state.copilotToken).toBe("stale-jwt");
    expect(tokenSignal.readScore()).toBe(1);
    fetchSpy.mockRestore();
  });

  test("401 token-expired + refresh FAILURE: no retry", async () => {
    const fetchSpy = mockScript({
      responses: [new Response("token expired", { status: 401 })],
      tokenRefresh: { ok: false, status: 500, body: "down" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotEmbeddingsClient();
    await expect(client.send({ input: "hi", model: "m" })).rejects.toThrow(
      "Failed to create embeddings",
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
    const client = createDefaultCopilotEmbeddingsClient();
    await expect(client.send({ input: "hi", model: "m" })).rejects.toThrow(
      "Failed to create embeddings",
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
    const client = createDefaultCopilotEmbeddingsClient();
    await expect(client.send({ input: "hi", model: "m" })).rejects.toThrow(
      "Failed to create embeddings",
    );
    expect(state.copilotToken).toBe("stale-jwt");
    fetchSpy.mockRestore();
  });

  test("401 retry STILL 401: throws retry error, no further refresh", async () => {
    const fetchSpy = mockScript({
      responses: [
        new Response("token expired", { status: 401 }),
        new Response("token expired again", { status: 401 }),
      ],
      tokenRefresh: { ok: true, token: "fresh-jwt" },
    });
    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotEmbeddingsClient();
    await expect(client.send({ input: "hi", model: "m" })).rejects.toThrow(
      "Failed to create embeddings",
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
      new Response(
        JSON.stringify({
          object: "list",
          data: [],
          model: "m",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({
          object: "list",
          data: [],
          model: "m",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
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

    const client = createDefaultCopilotEmbeddingsClient();
    const [rA, rB] = await Promise.all([
      client.send({ input: "a", model: "m" }),
      client.send({ input: "b", model: "m" }),
    ]);
    expect((rA as { object: string }).object).toBe("list");
    expect((rB as { object: string }).object).toBe("list");
    expect(tokenCalls).toBeLessThanOrEqual(1);
    expect(state.copilotToken).toBe("fresh-jwt");
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  test("snapshotAuth fixture parity: retry headers carry Authorization (no X-Initiator on embeddings)", async () => {
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
      const embCalls = calls.filter((c) => c.url.endsWith("/embeddings")).length;
      if (embCalls === 1) return Promise.resolve(new Response("token expired", { status: 401 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [],
            model: "m",
            usage: { prompt_tokens: 0, total_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch);

    handle = sentinelBootstrap({ token: "stale-jwt", refreshInSeconds: 1500 });
    vi.useFakeTimers({ now: Date.now() + 60_000 });

    const client = createDefaultCopilotEmbeddingsClient();
    await client.send({ input: "hi", model: "m" });

    const embCalls = calls.filter((c) => c.url.endsWith("/embeddings"));
    expect(embCalls).toHaveLength(2);
    expect(embCalls[0]!.auth).toBe("Bearer stale-jwt");
    expect(embCalls[0]!.xInitiator).toBe(null); // embeddings: no X-Initiator
    expect(embCalls[1]!.auth).toBe("Bearer fresh-jwt");
    expect(embCalls[1]!.xInitiator).toBe(null);

    vi.useRealTimers();
    fetchSpy.mockRestore();
  });
});
