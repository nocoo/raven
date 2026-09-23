import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApp } from "../packages/proxy/src/app"
import { initDatabase } from "../packages/proxy/src/db/requests"
import { initRouting } from "../packages/proxy/src/db/routing-migration"
import { replaceCatalog } from "../packages/proxy/src/db/catalog"
import { startRequestSink } from "../packages/proxy/src/db/request-sink"
import { COPILOT_UPSTREAM_ID } from "../packages/proxy/src/core/routing-types"
import { restoreCopilotCatalog } from "../packages/proxy/src/composition/catalog"
import { state } from "../packages/proxy/src/lib/state"
import { wsHandler, type WsData } from "../packages/proxy/src/ws/logs"
import { LEVEL_ORDER, type LogLevel } from "../packages/proxy/src/util/log-event"
import { chatResponse, responsesResponse } from "../packages/proxy/test/helpers/routing"
import { runRoutingBrowser, type CatalogFixtureFailure } from "../packages/dashboard/e2e/routing-isolated"

const root = resolve(import.meta.dir, "..")
const artifacts = mkdtempSync(join(tmpdir(), "raven-routing-ui-"))
chmodSync(artifacts, 0o700)
const stateDir = join(artifacts, "state")
mkdirSync(stateDir, { mode: 0o700 })
const dbPath = join(stateDir, "raven.db")
assert.equal(resolve(dbPath).startsWith(`${stateDir}/`), true)
const db = new Database(dbPath)
initDatabase(db)
initRouting(db)
chmodSync(dbPath, 0o600)
Object.assign(state, { githubToken: "fixture-github", copilotToken: "fixture-copilot", socks5Enabled: false })
replaceCatalog(db, COPILOT_UPSTREAM_ID, [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }])
restoreCopilotCatalog(db)
const stopSink = startRequestSink(db)
const hits: { path: string; model?: string; stream?: boolean }[] = []
const blocked: string[] = []
const fixtureErrors: string[] = []
let catalogFailure: CatalogFixtureFailure | null = null
const receiver = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (!["/v1/models", "/v1/chat/completions", "/v1/responses"].includes(path)) return new Response("Fixture route not found", { status: 404 })
    assert.equal(request.headers.get("authorization"), "Bearer fixture-provider")
    if (path === "/v1/models" && request.method === "GET") {
      hits.push({ path })
      const failure = catalogFailure
      catalogFailure = null
      if (failure === "wrong-shape") return Response.json({ models: [], api_key: "fixture-provider" }, { headers: { "x-request-id": "fixture-catalog-shape" } })
      if (failure === "non-json") return new Response("<html><body>Fixture gateway unavailable; api_key=fixture-provider</body></html>", { status: 502, headers: { "content-type": "text/html", "x-request-id": "fixture-catalog-gateway" } })
      return Response.json({ data: [{ id: "fixture-fast" }, { id: "fixture-smart" }] })
    }
    if (path === "/v1/chat/completions" && request.method === "POST") {
      const body = await request.json() as { model: string; stream?: boolean; max_completion_tokens?: number; messages?: { content: string }[] }
      hits.push({ path, model: body.model, stream: body.stream ?? false })
      if (body.messages?.[0]?.content === "ping. Reply with exactly pong.") {
        assert.equal(body.stream, false)
        assert.equal(body.max_completion_tokens, 32)
      }
      if (body.model === "fixture-fail") return Response.json({ error: { message: "Fixture quota refusal", api_key: "fixture-provider" }, usage: { prompt_tokens: 2, completion_tokens: 0 } }, { status: 429, headers: { "x-request-id": "fixture-generation-refusal" } })
      return Response.json(chatResponse(body.model, body.model === "fixture-unexpected" ? "Fixture reply: hello from the provider." : "pong"), { headers: { "x-request-id": "fixture-generation-chat" } })
    }
    if (path === "/v1/responses" && request.method === "POST") {
      const body = await request.json() as { model: string; stream?: boolean; input: string; max_output_tokens: number }
      hits.push({ path, model: body.model, stream: body.stream ?? false })
      assert.equal(body.model, "fixture-reasoning-only")
      assert.equal(body.input, "ping. Reply with exactly pong.")
      assert.equal(body.stream, false)
      assert.equal(body.max_output_tokens, 32)
      return Response.json({
        ...responsesResponse(body.model), status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
        output: [{ id: "reasoning-fixture", type: "reasoning", summary: [{ type: "summary_text", text: "Fixture reasoning without a visible answer." }] }],
      }, { headers: { "x-request-id": "fixture-generation-reasoning" } })
    }
    return new Response("Fixture route not found", { status: 404 })
  },
  error(error) {
    fixtureErrors.push(error.message)
    return new Response("Fixture assertion failed", { status: 500 })
  },
})
const receiverUrl = receiver.url.origin
const app = createApp({ db, githubToken: "fixture-github", apiKey: "fixture-client", internalKey: "fixture-internal" })
const proxy = Bun.serve<WsData>({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/ws/logs") {
      if (url.searchParams.get("token") !== "fixture-internal") return new Response("Unauthorized", { status: 401 })
      const level = url.searchParams.get("level") ?? "info"
      const minLevel: LogLevel = Object.hasOwn(LEVEL_ORDER, level) ? level as LogLevel : "info"
      if (server.upgrade(request, { data: { minLevel, filterRequestId: url.searchParams.get("requestId") } })) return
      return new Response("WebSocket upgrade failed", { status: 400 })
    }
    return app.fetch(request, server)
  },
  websocket: wsHandler,
})
const nativeFetch = globalThis.fetch
const allowed = new Set([receiverUrl, proxy.url.origin])
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === "https://api.github.com" && url.pathname === "/copilot_internal/user") {
    return Response.json({ login: "fixture-user", copilot_plan: "individual", chat_enabled: true, is_mcp_enabled: true, assigned_date: "2026-09-21T20:30:00Z", analytics_tracking_id: "fixture-tracking", endpoints: { api: "https://fixture.invalid/api" }, quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80, unlimited: false, overage_count: 0 } } })
  }
  if (!allowed.has(url.origin)) {
    blocked.push(`${url.origin}${url.pathname}`)
    throw new Error(`Isolated verification blocked external fetch: ${url.origin}`)
  }
  return nativeFetch(input, init)
}, { preconnect: nativeFetch.preconnect }) as typeof fetch

const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = portReservation.port!
portReservation.stop(true)
const dashboardUrl = `http://127.0.0.1:${port}`
allowed.add(dashboardUrl)
const nextLog = Bun.file(join(artifacts, "next.log"))
const next = Bun.spawn(["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: join(root, "packages/dashboard"),
  env: {
    PATH: process.env.PATH,
    NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC",
    GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", NEXTAUTH_SECRET: "", NEXTAUTH_URL: dashboardUrl,
    RAVEN_PROXY_URL: proxy.url.origin, RAVEN_INTERNAL_KEY: "fixture-internal", RAVEN_API_KEY: "fixture-client",
    RAVEN_CONFIG_DIR: stateDir, RAVEN_DATA_DIR: stateDir, RAVEN_TOKEN_PATH: join(stateDir, "token"), RAVEN_DB_PATH: dbPath,
  },
  stdout: nextLog, stderr: nextLog,
})
const cleanup = () => {
  next.kill()
  proxy.stop(true)
  receiver.stop(true)
  stopSink()
  db.close()
  globalThis.fetch = nativeFetch
  assert.equal(stateDir, join(artifacts, "state"))
  rmSync(stateDir, { recursive: true, force: true })
}
let result: Awaited<ReturnType<typeof runRoutingBrowser>>
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (next.exitCode !== null) throw new Error(`Next exited with ${next.exitCode}; see ${nextLog.name}`)
    try { ready = (await fetch(`${dashboardUrl}/api/auth/config`)).ok } catch { /* The isolated server is still starting. */ }
    if (ready) break
    await Bun.sleep(200)
  }
  assert.equal(ready, true, "Isolated Next server did not start")
  result = await runRoutingBrowser({
    dashboardUrl, receiverUrl, proxyUrl: proxy.url.origin, artifacts,
    inspect: () => ({ catalogCalls: hits.filter(hit => hit.path === "/v1/models").length, generationCalls: hits.filter(hit => hit.model).length }),
    nextCatalogResponse: kind => { assert.equal(catalogFailure, null); catalogFailure = kind },
  })
  assert.equal(catalogFailure, null, "Every configured fixture failure must be consumed")
  assert.deepEqual(blocked, [])
  assert.deepEqual(fixtureErrors, [])
} catch (error) {
  console.error(`隔离 Routing 浏览器验收失败；证据 ${artifacts}`)
  throw error
} finally {
  cleanup()
  await next.exited
}
assert.equal(existsSync(stateDir), false)
await Bun.write(join(artifacts, "report.json"), JSON.stringify({ ...result, hits, blocked, fixture_errors: fixtureErrors, database_removed: true }, null, 2))
console.info(`隔离 Routing 浏览器验收通过：${result.checks.length} 项；证据 ${artifacts}`)
