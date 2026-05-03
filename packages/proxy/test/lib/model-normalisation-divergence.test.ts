/**
 * §2.2(7) model-normalisation contract.
 *
 * After A.6, `/v1/messages` resolves provider against the normalised
 * Copilot model, so custom provider patterns authored as
 * `claude-opus-4.6` match raw dated inputs like
 * `claude-opus-4-6-20250820`. `/v1/chat/completions` continues to
 * match on the raw model — OpenAI-format clients send the raw model
 * verbatim.
 *
 * These tests pin the fixed behaviour so that a future refactor can't
 * regress back to raw-model matching on the messages entry.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"

import { handleCompletion as handleMessages } from "../../src/routes/messages/handler"
import { state } from "../../src/lib/state"
import { resolveProvider } from "../../src/lib/upstream-router"
import type { ProviderRecord } from "../../src/db/providers"
import { compileProvider } from "../../src/db/providers"
import { translateModelName } from "../../src/protocols/anthropic/preprocess"

const RAW_DATED = "claude-opus-4-6-20250820"
const NORMALISED = "claude-opus-4.6"

const baseRecord: ProviderRecord = {
  id: "p-norm",
  name: "NormalisedMatcher",
  base_url: "https://example.com",
  format: "anthropic",
  api_key: "key",
  model_patterns: `["${NORMALISED}"]`,
  enabled: 1,
  created_at: 1,
  updated_at: 1,
  supports_reasoning: 0,
  supports_models_endpoint: 0,
  use_socks5: null,
}

function setProviders(records: ProviderRecord[]): void {
  state.providers = records
    .map(compileProvider)
    .filter((p): p is NonNullable<typeof p> => p !== null)
}

describe("§2.2(7) — helper-layer facts", () => {
  beforeEach(() => {
    state.providers = []
    setProviders([baseRecord])
  })

  test("translateModelName maps raw dated form to canonical Copilot form", () => {
    expect(translateModelName(RAW_DATED, null)).toBe(NORMALISED)
  })

  test("raw-model resolveProvider misses a normalised-form pattern", () => {
    expect(resolveProvider(RAW_DATED)).toBeNull()
  })

  test("normalised-model resolveProvider hits the pattern", () => {
    expect(resolveProvider(NORMALISED)?.provider.name).toBe("NormalisedMatcher")
  })

  test("A.6 target: normalising first lets raw dated inputs resolve", () => {
    const resolved = resolveProvider(translateModelName(RAW_DATED, null))
    expect(resolved?.matchedPattern).toBe(NORMALISED)
  })
})

describe("§2.2(7) — handler contract", () => {
  let savedProviders: typeof state.providers
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    savedProviders = state.providers
    originalFetch = globalThis.fetch
    setProviders([baseRecord])
  })

  afterEach(() => {
    state.providers = savedProviders
    globalThis.fetch = originalFetch
  })

  // A.6 landed: messages-handler.ts now calls
  // resolveProvider(translateModelName(rawModel, anthropicBeta)).
  // This assertion now passes as a regular test.
  test(
    "/v1/messages routes raw dated model through a normalised-pattern provider",
    async () => {
      const captured: { url: string | null } = { url: null }
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        captured.url = typeof input === "string" ? input : (input as URL).toString()
        return new Response(
          JSON.stringify({
            id: "msg_x",
            type: "message",
            role: "assistant",
            model: NORMALISED,
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as typeof globalThis.fetch

      const app = new Hono()
      app.post("/v1/messages", handleMessages)
      const res = await app.request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: RAW_DATED,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      })

      expect(res.status).toBe(200)
      expect(captured.url).toContain("example.com")
    },
  )

  // Backward-compat pin. The A.6 change must NOT regress the existing
  // use case where a provider is configured with the raw dated model
  // verbatim — that pattern still needs to match a raw dated request.
  test("/v1/messages still honours a raw-dated exact pattern", async () => {
    setProviders([
      {
        ...baseRecord,
        id: "p-raw",
        name: "RawMatcher",
        base_url: "https://raw.example.com",
        model_patterns: `["${RAW_DATED}"]`,
      },
    ])
    const captured: { url: string | null } = { url: null }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.url = typeof input === "string" ? input : (input as URL).toString()
      return new Response(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: RAW_DATED,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof globalThis.fetch

    const app = new Hono()
    app.post("/v1/messages", handleMessages)
    const res = await app.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: RAW_DATED,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(captured.url).toContain("raw.example.com")
  })

  // When BOTH a raw and a canonical provider could match, the raw
  // pattern wins. This preserves the "more specific pattern first"
  // intuition for operators who registered a dated pin to pin an
  // exact snapshot of a model.
  test("raw-exact pattern wins over canonical pattern when both match", async () => {
    setProviders([
      {
        ...baseRecord,
        id: "p-raw",
        name: "RawMatcher",
        base_url: "https://raw.example.com",
        model_patterns: `["${RAW_DATED}"]`,
      },
      {
        ...baseRecord,
        id: "p-norm",
        name: "NormalisedMatcher",
        base_url: "https://norm.example.com",
        model_patterns: `["${NORMALISED}"]`,
      },
    ])
    const captured: { url: string | null } = { url: null }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.url = typeof input === "string" ? input : (input as URL).toString()
      return new Response(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: RAW_DATED,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof globalThis.fetch

    const app = new Hono()
    app.post("/v1/messages", handleMessages)
    const res = await app.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: RAW_DATED,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(captured.url).toContain("raw.example.com")
  })

  // When a raw **glob** and a canonical **exact** could both claim the
  // request, exact must win — across candidates. Input
  // `claude-opus-4-6-20250820` matches both `claude-opus-*` (raw glob)
  // and (after normalisation) `claude-opus-4.6` (canonical exact).
  // The canonical-exact provider must win.
  test("canonical-exact pattern beats raw-glob pattern across candidates", async () => {
    setProviders([
      {
        ...baseRecord,
        id: "p-raw-glob",
        name: "RawGlobMatcher",
        base_url: "https://rawglob.example.com",
        model_patterns: `["claude-opus-*"]`,
      },
      {
        ...baseRecord,
        id: "p-norm-exact",
        name: "NormalisedExactMatcher",
        base_url: "https://norm.example.com",
        model_patterns: `["${NORMALISED}"]`,
      },
    ])
    const captured: { url: string | null } = { url: null }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.url = typeof input === "string" ? input : (input as URL).toString()
      return new Response(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: NORMALISED,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof globalThis.fetch

    const app = new Hono()
    app.post("/v1/messages", handleMessages)
    const res = await app.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: RAW_DATED,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(captured.url).toContain("norm.example.com")
  })
})
