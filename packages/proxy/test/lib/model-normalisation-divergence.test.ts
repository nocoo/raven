/**
 * A.4 — Red test for §2.2(7) model-normalisation divergence.
 *
 * Bug: `/v1/messages` preprocesses the Anthropic model into the Copilot
 * canonical form (`claude-opus-4-6-20250820` → `claude-opus-4.6`) before
 * translating, but provider resolution in handler.ts runs on the RAW
 * model. A custom provider authored with the normalised pattern
 * therefore never matches raw dated forms, even though the downstream
 * pipeline treats them as equivalent.
 *
 * `/v1/chat/completions` does not normalise and matches on raw model.
 * This is correct — OpenAI-format clients send the raw model verbatim.
 *
 * This file marks the broken `/v1/messages` assertion with `test.failing`;
 * A.6 will land the handler change and flip it to a normal `test`.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Hono } from "hono"

import { handleCompletion as handleMessages } from "../../src/routes/messages/handler"
import { state } from "../../src/lib/state"
import { resolveProvider } from "../../src/lib/upstream-router"
import type { ProviderRecord } from "../../src/db/providers"
import { compileProvider } from "../../src/db/providers"
import { translateModelName } from "../../src/routes/messages/preprocess"

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

describe("§2.2(7) — handler contract (red until A.6)", () => {
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

  // Marked `.failing` because today messages-handler.ts calls
  // resolveProvider(rawModel) before preprocess runs. A.6 flips this call
  // site to use the normalised model and this assertion will pass. Flip
  // `test.failing` → `test` in the A.6 commit.
  test.failing(
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
})
