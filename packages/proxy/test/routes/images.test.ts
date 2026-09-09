import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { createApp } from "../../src/app"
import {
  dispatchImageGeneration,
  defaultImageDispatchDeps,
} from "../../src/composition/images"
import { buildUpstreamClient } from "../../src/composition/upstream-registry"
import { createImageRoutes } from "../../src/routes/images/route"
import { apiKeyAuth, invalidateKeyCountCache } from "../../src/middleware"
import { initApiKeys, createApiKey, revokeApiKey } from "../../src/db/keys"
import { initDatabase } from "../../src/db/requests"
import type { CompiledProvider } from "../../src/db/providers"
import { HTTPError } from "../../src/lib/error"
import { logEmitter } from "../../src/util/log-emitter"

const provider: CompiledProvider = {
  id: "image-upstream",
  name: "Images",
  base_url: "https://images.example.test",
  format: "openai",
  api_key: "test-upstream-key",
  enabled: 1,
  supports_reasoning: 0,
  supports_models_endpoint: 0,
  use_socks5: 0,
  created_at: 0,
  updated_at: 0,
  patterns: [{ raw: "gpt-image-2", isExact: true }],
}
const payload = {
  model: "gpt-image-2",
  prompt: "PRIVATE_PROMPT",
  size: "1536x864",
  output_format: "png",
  background: "transparent",
  quality: "high",
  n: 1,
}
const result = {
  created: 123,
  data: [
    {
      b64_json: "PRIVATE_IMAGE_BASE64",
      url: "https://image.test/private",
      revised_prompt: "PRIVATE_REVISED_PROMPT",
    },
  ],
  usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
  size: "1536x864",
}

describe("image generation JSON passthrough", () => {
  let db: Database
  let fetchSpy: MockInstance<typeof fetch>
  let logSpy: MockInstance<typeof logEmitter.emitLog>
  let providers: CompiledProvider[]
  let rateLimit: ReturnType<typeof vi.fn<() => Promise<void>>>

  beforeEach(() => {
    db = new Database(":memory:")
    initDatabase(db)
    initApiKeys(db)
    invalidateKeyCountCache()
    providers = [provider]
    rateLimit = vi.fn(async () => {})
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(result))
    logSpy = vi.spyOn(logEmitter, "emitLog").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function app() {
    const hono = new Hono()
    hono.use("/v1/*", apiKeyAuth({ db, envApiKey: "test-client-key" }))
    hono.route(
      "/v1/images/generations",
      createImageRoutes((value, signal) =>
        dispatchImageGeneration(value, signal, {
          providers,
          checkRateLimit: rateLimit,
          client: buildUpstreamClient("custom-images", {
            customImages: { getProxyUrl: () => undefined },
          }),
        }),
      ),
    )
    return hono
  }
  function request(body: unknown = payload, key = "test-client-key") {
    return app().request("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    })
  }

  test("preserves gpt-image-2 options, image response and usage; never logs content", async () => {
    const body = {
      ...payload,
      output_compression: 80,
      moderation: "auto",
      future_option: { foo: "bar" },
      user: "PRIVATE_USER",
      stream: false,
    }
    const res = await request(body)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "https://images.example.test/v1/images/generations",
    ])
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe("https://images.example.test/v1/images/generations")
    expect(JSON.parse(init!.body as string)).toEqual(body)
    expect(init!.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-upstream-key",
    })
    expect(init!.redirect).toBe("error")
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    expect(rateLimit).toHaveBeenCalledOnce()
    const logs = JSON.stringify(logSpy.mock.calls)
    for (const secret of [
      payload.prompt,
      "PRIVATE_IMAGE_BASE64",
      "PRIVATE_REVISED_PROMPT",
      "PRIVATE_USER",
      provider.api_key,
      "test-client-key",
      "https://image.test/private",
    ])
      expect(logs).not.toContain(secret)
    expect(logSpy.mock.calls.map(([event]) => event.type)).toEqual([
      "request_start",
      "request_end",
    ])
  })

  test.each(["", "wrong-key"])(
    "rejects unauthorized key %s before upstream",
    async (key) => {
      expect((await request(payload, key)).status).toBe(401)
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )
  test("accepts DB key and rejects revoked key", async () => {
    const key = createApiKey(db, "images-client")
    invalidateKeyCountCache()
    expect((await request(payload, key.key)).status).toBe(200)
    revokeApiKey(db, key.id)
    expect((await request(payload, key.key)).status).toBe(401)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
  test("production app mounts endpoint under strict auth, rejecting internal credentials", async () => {
    const productionApp = createApp({
      db,
      apiKey: "test-client-key",
      internalKey: "internal",
      githubToken: "unused",
    })
    for (const key of ["", "internal"]) {
      const res = await productionApp.request("/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      })
      expect(res.status).toBe(401)
    }
    const res = await productionApp.request("/v1/images/generations", {
      method: "POST",
      headers: { Authorization: "Bearer test-client-key" },
      body: "{}",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toHaveProperty(
      "error.type",
      "invalid_request_error",
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    null,
    [],
    "text",
    {},
    { ...payload, model: " " },
    { ...payload, prompt: " " },
    { ...payload, prompt: 123 },
    { ...payload, stream: true },
    { ...payload, stream: "false" },
    { ...payload, n: 0 },
    { ...payload, n: 11 },
    { ...payload, n: 1.5 },
    { ...payload, output_compression: 101 },
    { ...payload, size: {} },
    { ...payload, partial_images: 4 },
  ])("rejects invalid payload %# without a paid request", async (body) => {
    const res = await request(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toHaveProperty(
      "error.type",
      "invalid_request_error",
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test("malformed JSON has structured 400", async () => {
    const res = await app().request("/v1/images/generations", {
      method: "POST",
      headers: { Authorization: "Bearer test-client-key" },
      body: "{PRIVATE_INVALID_JSON",
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
      "PRIVATE_INVALID_JSON",
    )
  })
  test.each([
    [[]],
    [[{ ...provider, enabled: 0 }]],
    [[{ ...provider, patterns: [{ raw: "other-model", isExact: true }] }]],
  ])(
    "never falls back to Copilot without a matching enabled provider %#",
    async (configured) => {
      providers = configured
      const res = await request()
      expect(res.status).toBe(400)
      expect(await res.text()).toContain("matching model pattern")
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )
  test("rejects matched Anthropic provider without skipping to another paid upstream", async () => {
    providers = [
      { ...provider, format: "anthropic" },
      { ...provider, id: "second" },
    ]
    const res = await request()
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("Anthropic")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test("exact model match beats earlier glob; glob matching uses configured prefix", async () => {
    providers = [
      {
        ...provider,
        base_url: "https://glob.test",
        patterns: [{ raw: "gpt-*", isExact: false, prefix: "gpt-" }],
      },
      provider,
    ]
    expect((await request()).status).toBe(200)
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://images.example.test/v1/images/generations",
    )
    fetchSpy.mockResolvedValueOnce(Response.json(result))
    expect(
      (await request({ ...payload, model: "gpt-image-future" })).status,
    ).toBe(200)
    expect(fetchSpy.mock.calls[1]![0]).toBe(
      "https://glob.test/v1/images/generations",
    )
  })
  test("rate limit rejects before upstream", async () => {
    rateLimit.mockRejectedValue(new HTTPError("Rate limit exceeded.", 429))
    expect((await request()).status).toBe(429)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test("rejects bodies over 1 MiB and prompts over 32000 characters before upstream", async () => {
    expect(
      (await request({ ...payload, prompt: "x".repeat(32_001) })).status,
    ).toBe(400)
    expect(
      (await request({ ...payload, extra: "x".repeat(1024 * 1024) })).status,
    ).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test("propagates caller cancellation and sets the five-minute timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
    const controller = new AbortController()
    const client = buildUpstreamClient("custom-images", {
      customImages: { getProxyUrl: () => undefined },
    })
    await client.send(provider, payload, controller.signal)
    const signal = fetchSpy.mock.calls[0]![1]!.signal!
    expect(signal.aborted).toBe(false)
    controller.abort()
    expect(signal.aborted).toBe(true)
    expect(timeout).toHaveBeenCalledWith(300_000)
  })
  test.each([400, 401, 429, 500, 503])(
    "preserves upstream JSON error status %s without logging error bodies",
    async (status) => {
      const error = {
        error: {
          message: "PRIVATE_PROMPT PRIVATE_IMAGE_BASE64",
          type: "upstream_error",
          code: "quota_exceeded",
        },
      }
      fetchSpy.mockResolvedValue(
        Response.json(error, {
          status,
          headers: { "Retry-After": "30", "Set-Cookie": "private=secret" },
        }),
      )
      const res = await request()
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual(error)
      expect(res.headers.get("retry-after")).toBe("30")
      expect(res.headers.has("set-cookie")).toBe(false)
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("PRIVATE_")
    },
  )
  test.each(["<html>PRIVATE_PROMPT</html>", "data: PRIVATE_IMAGE_BASE64", ""])(
    "rejects non-JSON upstream response %# safely",
    async (body) => {
      fetchSpy.mockResolvedValue(new Response(body))
      const res = await request()
      expect(res.status).toBe(502)
      expect(await res.text()).not.toContain("PRIVATE_")
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("PRIVATE_")
    },
  )
  test("network failures do not expose URL/credentials in response or logs", async () => {
    fetchSpy.mockRejectedValue(
      new Error("https://PRIVATE_KEY@upstream.test PRIVATE_PROMPT"),
    )
    const res = await request()
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain("PRIVATE_")
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("PRIVATE_")
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
  test.each([
    "https://images.test",
    "https://images.test/",
    "https://images.test/v1",
    "https://images.test/v1/",
    "https://images.test/v1///",
    "https://images.test/custom/v1",
  ])("joins base URL %s without duplicate v1", async (baseUrl) => {
    providers = [{ ...provider, base_url: baseUrl }]
    await request()
    const prefix = baseUrl.includes("/custom/") ? "/custom" : ""
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      `https://images.test${prefix}/v1/images/generations`,
    )
  })
  test("upstream supports configured SOCKS proxy without reading state", async () => {
    const client = buildUpstreamClient("custom-images", {
      customImages: { getProxyUrl: () => "http://localhost:18080" },
    })
    await client.send(provider, payload)
    expect(fetchSpy.mock.calls[0]![1]).toHaveProperty(
      "proxy",
      "http://localhost:18080",
    )
  })
  test("production composition defaults are wired without live HTTP", () => {
    const deps = defaultImageDispatchDeps()
    expect(Array.isArray(deps.providers)).toBe(true)
    expect(typeof deps.checkRateLimit).toBe("function")
    expect(typeof buildUpstreamClient("custom-images").send).toBe("function")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
