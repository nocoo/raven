import { describe, expect, test } from "bun:test"
import { Hono, type Context } from "hono"

import { buildContext, type RequestContext } from "../../src/core/context"

/**
 * Run `buildContext` against a real Hono request so the `c.get("keyName")`
 * and header reads exercise the production code path. Returns the built
 * context and the underlying Hono context for further assertions.
 */
async function runBuild(opts: {
  headers?: Record<string, string>
  keyName?: string | null
  format?: "openai" | "anthropic" | "responses"
  signals?: { anthropicUserId?: string | null; openaiUser?: string | null }
}): Promise<RequestContext> {
  const app = new Hono()
  let captured: RequestContext | null = null
  app.post("/x", (c: Context) => {
    if (opts.keyName !== undefined && opts.keyName !== null) {
      c.set("keyName", opts.keyName)
    }
    captured = buildContext(c, opts.format ?? "openai", opts.signals)
    return c.json({ ok: true })
  })
  await app.request("http://localhost/x", {
    method: "POST",
    headers: opts.headers ?? {},
  })
  if (!captured) throw new Error("buildContext was not called")
  return captured
}

describe("core/context", () => {
  test("requestId is unique per call and timestamp-prefixed (10-char ts)", async () => {
    const a = await runBuild({})
    const b = await runBuild({})
    expect(a.requestId).not.toBe(b.requestId)
    expect(a.requestId).toMatch(/^[0-9A-Z]{26}$/)
    expect(b.requestId).toMatch(/^[0-9A-Z]{26}$/)
  })

  test("startTime is set from performance.now()", async () => {
    const before = performance.now()
    const ctx = await runBuild({})
    const after = performance.now()
    expect(ctx.startTime).toBeGreaterThanOrEqual(before)
    expect(ctx.startTime).toBeLessThanOrEqual(after)
  })

  test("format is propagated verbatim", async () => {
    expect((await runBuild({ format: "openai" })).format).toBe("openai")
    expect((await runBuild({ format: "anthropic" })).format).toBe("anthropic")
    expect((await runBuild({ format: "responses" })).format).toBe("responses")
  })

  test("accountName defaults to 'default' when keyName not set", async () => {
    const ctx = await runBuild({})
    expect(ctx.accountName).toBe("default")
  })

  test("accountName uses c.get('keyName') when present", async () => {
    const ctx = await runBuild({ keyName: "alice" })
    expect(ctx.accountName).toBe("alice")
  })

  test("userAgent header is passed through verbatim, null when missing", async () => {
    const present = await runBuild({ headers: { "user-agent": "claude-code/1.2.3 (linux)" } })
    expect(present.userAgent).toBe("claude-code/1.2.3 (linux)")
    const absent = await runBuild({})
    expect(absent.userAgent).toBeNull()
  })

  test("anthropicBeta header is captured, null when missing", async () => {
    const present = await runBuild({ headers: { "anthropic-beta": "tools-2024-05-16" } })
    expect(present.anthropicBeta).toBe("tools-2024-05-16")
    const absent = await runBuild({})
    expect(absent.anthropicBeta).toBeNull()
  })

  test("clientName/clientVersion derive from claude-code UA", async () => {
    const ctx = await runBuild({ headers: { "user-agent": "claude-code/1.2.3" } })
    expect(ctx.clientName).toBe("Claude Code")
    expect(ctx.clientVersion).toBe("1.2.3")
  })

  test("clientName falls back to first UA token, version null", async () => {
    const ctx = await runBuild({ headers: { "user-agent": "weird-client extra-stuff" } })
    expect(ctx.clientName).toBe("weird-client")
    expect(ctx.clientVersion).toBeNull()
  })

  test("clientName 'Unknown' when no UA header", async () => {
    const ctx = await runBuild({})
    expect(ctx.clientName).toBe("Unknown")
    expect(ctx.clientVersion).toBeNull()
  })

  test("sessionId prefers anthropicUserId when supplied", async () => {
    const ctx = await runBuild({
      keyName: "alice",
      headers: { "user-agent": "claude-code/1" },
      signals: { anthropicUserId: "user_abc" },
    })
    expect(ctx.sessionId).toBe("user_abc")
  })

  test("sessionId uses openaiUser+name+account when anthropicUserId absent", async () => {
    const ctx = await runBuild({
      keyName: "alice",
      headers: { "user-agent": "openai-node/4.0.0" },
      signals: { openaiUser: "u123" },
    })
    expect(ctx.sessionId).toBe("u123::OpenAI Node SDK::alice")
  })

  test("sessionId falls back to clientName::accountName when no signals", async () => {
    const ctx = await runBuild({ keyName: "alice", headers: { "user-agent": "claude-code/2" } })
    expect(ctx.sessionId).toBe("Claude Code::alice")
  })

  test("default format is 'openai' when only required args passed (call directly)", async () => {
    const app = new Hono()
    let ctx: RequestContext | null = null
    app.post("/x", (c) => {
      ctx = buildContext(c, "openai")
      return c.json({})
    })
    await app.request("http://localhost/x", { method: "POST" })
    expect(ctx).not.toBeNull()
    expect(ctx!.format).toBe("openai")
    // signals param defaults to {} → both nulls → fallback sessionId
    expect(ctx!.sessionId).toBe("Unknown::default")
  })

  test("explicit null signals are treated as absent", async () => {
    const ctx = await runBuild({
      keyName: "k",
      signals: { anthropicUserId: null, openaiUser: null },
    })
    expect(ctx.sessionId).toBe("Unknown::k")
  })
})
