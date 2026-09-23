import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createApiKey, revokeApiKey } from "../../../packages/proxy/src/db/keys"
import { initDatabase } from "../../../packages/proxy/src/db/requests"
import { replaceCatalog } from "../../../packages/proxy/src/db/catalog"
import { routingFixture } from "../../../packages/proxy/test/db/routing-fixture"
import { liveCases, type LiveCase } from "../live-proxy-cases"
import { assertLiveTelemetry, liveNativeEvidence, livePreflight, liveProxyUrl, openLiveDatabase, parseLiveKey, readLiveKey, readLiveTelemetry, runLiveCases, type LiveResult } from "../live-proxy-runner"
import { fixtureJson, fixtureSse, seedTelemetry } from "./live-proxy-fixtures"

const root = resolve(import.meta.dirname, "../../..")
const first = liveCases[0]!
let fixture: ReturnType<typeof routingFixture>
let reader: Database
let identity: ReturnType<typeof createApiKey>
let privateKeyPath: string

beforeEach(() => {
  fixture = routingFixture()
  initDatabase(fixture.db)
  identity = createApiKey(fixture.db, "Fixture live key", "builtin:copilot")
  replaceCatalog(fixture.db, "builtin:copilot", [
    { id: "gemini-3.8-flash", supported_endpoints: ["/chat/completions"] },
    { id: "grok-4.5", supported_endpoints: ["/responses"] },
    { id: "gpt-5.6-sol", supported_endpoints: ["/responses", "ws:/responses"] },
    { id: "claude-opus-5.5", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  ])
  reader = new Database(fixture.path, { readonly: true, strict: true })
  privateKeyPath = join(dirname(fixture.path), "synthetic-key")
  writeFileSync(privateKeyPath, `${identity.key}\n`, { mode: 0o600 })
})

afterEach(() => {
  reader.close()
  fixture.close()
})

describe("live preflight boundaries", () => {
  test("opens an existing writable database but never creates a missing live database", () => {
    const db = openLiveDatabase(fixture.path)
    try {
      db.query("UPDATE api_keys SET name = ? WHERE id = ?").run("Updated fixture", identity.id)
      expect(reader.query<{ name: string }, [string]>("SELECT name FROM api_keys WHERE id = ?").get(identity.id)?.name).toBe("Updated fixture")
    } finally { db.close() }
    const missing = join(dirname(fixture.path), "missing.db")
    expect(() => openLiveDatabase(missing)).toThrow()
    expect(existsSync(missing)).toBe(false)
  })

  test.each(["http://127.0.0.1:7024", "https://localhost:9999/", "http://[::1]:80"])("allows loopback %s", (url) => {
    expect(liveProxyUrl(url)).toBe(new URL(url).origin)
  })

  test.each(["https://provider.invalid", "ftp://127.0.0.1", "http://key@localhost", "http://localhost/path", "http://localhost/?secret=x", "http://localhost/#x", "not-a-url"])("rejects unsafe origin %s", (url) => {
    expect(() => liveProxyUrl(url)).toThrow()
  })

  test("requires a private raw key file and does not expose database hashes", () => {
    expect(readLiveKey(privateKeyPath)).toBe(identity.key)
    const value = livePreflight(reader, identity.key, liveCases)
    expect(value.key).toEqual({ id: identity.id, name: identity.name, rule_id: "builtin:copilot" })
    expect(JSON.stringify(value)).not.toContain(identity.key)
    expect(JSON.stringify(value)).not.toContain("key_hash")
    expect(value.catalog).toHaveLength(4)
    expect(value.rule.allow_conversion).toBe(true)
    chmodSync(privateKeyPath, 0o644)
    expect(() => readLiveKey(privateKeyPath)).toThrow("private")
  })

  test.each(["", "short", "fixture-key-with whitespace", "x".repeat(4097)])("rejects invalid key file contents (%#)", (contents) => {
    writeFileSync(privateKeyPath, contents)
    expect(() => readLiveKey(privateKeyPath)).toThrow()
    expect(() => parseLiveKey(contents)).toThrow()
  })

  test("rejects a directory or absent key path", () => {
    expect(() => readLiveKey(dirname(fixture.path))).toThrow("plain-text file")
    expect(() => readLiveKey(join(dirname(fixture.path), "absent"))).toThrow()
  })

  test("rejects a wrong or revoked key before accessing routing", () => {
    expect(() => livePreflight(reader, "fixture-wrong-key", liveCases)).toThrow("active database key")
    revokeApiKey(fixture.db, identity.id)
    expect(() => livePreflight(reader, identity.key, liveCases)).toThrow("active database key")
  })

  test("requires the native Messages endpoint for Claude Messages cases", () => {
    replaceCatalog(fixture.db, "builtin:copilot", [{ id: "claude-opus-5.5", supported_endpoints: ["/chat/completions"] }])
    const entry = liveCases.find((item) => item.model === "claude-opus-5.5" && item.protocol === "messages")!
    expect(() => livePreflight(reader, identity.key, [entry])).toThrow("Cached endpoints changed")
  })

  test.each([
    ["conversion disabled", "UPDATE routing_rules SET allow_conversion = 0"],
    ["scheduled rule", "UPDATE routing_rules SET mode = 'daily'"],
    ["changed chain", `UPDATE routing_rules SET default_chain = '[{"upstream_id":"builtin:copilot","model":"other-model"}]'`],
    ["empty catalog", "UPDATE providers SET models = '[]'"],
    ["unknown endpoints", `UPDATE providers SET models = '[{"id":"gemini-3.8-flash"}]'`],
    ["changed endpoints", `UPDATE providers SET models = '[{"id":"gemini-3.8-flash","supported_endpoints":["/responses"]}]'`],
  ] as const)("rejects %s without refreshing or repairing configuration", (_name, sql) => {
    fixture.db.exec(sql)
    expect(() => livePreflight(reader, identity.key, [first])).toThrow()
  })
})

describe("persisted route and attempt assertions", () => {
  test("accepts honestly missing translated streaming usage but not an enabled quota or false completeness", () => {
    const entry = liveCases.find(value => value.stream && value.upstreamFormat === "openai" && value.protocol !== "chat")!
    seedTelemetry(fixture.db, entry, identity.id, "absent-usage")
    const telemetry = readLiveTelemetry(reader, "absent-usage")!
    Object.assign(telemetry.attempts[0]!, { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, usage_present: 0, usage_complete: 0, weighted_debit: 0 })
    Object.assign(telemetry.routing!, { usage_complete: false, weighted_tokens: 0 })
    expect(() => assertLiveTelemetry(entry, telemetry, identity.id)).not.toThrow()
    telemetry.routing!.usage_complete = true
    expect(() => assertLiveTelemetry(entry, telemetry, identity.id)).toThrow("incomplete")
    telemetry.routing!.quota_window_id = "quota-enabled"
    expect(() => assertLiveTelemetry(entry, telemetry, identity.id)).toThrow("usage")
  })

  test("exports only successful single-attempt native text evidence", () => {
    seedTelemetry(fixture.db, first, identity.id, "native")
    const result: LiveResult = { case_id: first.id, status: "passed", started_at: "2026-09-23T00:00:00Z", telemetry: readLiveTelemetry(reader, "native"), errors: [] }
    const revision = "a".repeat(40)
    const evidence = liveNativeEvidence(liveCases, [result], revision)
    expect(evidence).toEqual([{ upstream: "copilot", model: first.model, protocol: first.upstreamFormat, stream: false, tested_at: result.started_at, revision, case_id: first.id }])
    expect(JSON.stringify(evidence)).not.toContain(identity.id)
    for (const entry of liveCases.filter(value => value.kind !== "text" || value.clientFormat !== value.upstreamFormat || value.model === "auto")) {
      expect(liveNativeEvidence(liveCases, [{ ...result, case_id: entry.id }], revision)).toEqual([])
    }
    expect(liveNativeEvidence(liveCases, [{ ...result, status: "failed" }, { ...result, case_id: "unknown" }], revision)).toEqual([])
    expect(() => liveNativeEvidence(liveCases, [{ ...result, telemetry: null }], revision)).toThrow("single-attempt")
    expect(() => liveNativeEvidence(liveCases, [result], "invalid")).toThrow()
    result.telemetry!.request.upstream_format = "responses"
    expect(() => liveNativeEvidence(liveCases, [result], revision)).toThrow()
  })
  test("reads only its correlation ID and keeps upstream echo separate from the admitted model", () => {
    expect(readLiveTelemetry(reader, "not-found")).toBeNull()
    seedTelemetry(fixture.db, first, identity.id, "case-one")
    const telemetry = readLiveTelemetry(reader, "case-one")!
    expect(telemetry.request.resolved_model).toBe("upstream-echo-model")
    expect(telemetry.routing?.resolved_model).toBe(first.resolvedModel)
    expect(() => assertLiveTelemetry(first, telemetry, identity.id)).not.toThrow()
    seedTelemetry(fixture.db, first, identity.id, "case-one")
    expect(() => readLiveTelemetry(reader, "case-one")).toThrow("Multiple requests")
  })

  test("reports absent routing details and a mismatched rule", () => {
    seedTelemetry(fixture.db, first, identity.id, "missing-routing", { routing_details: null })
    const missing = readLiveTelemetry(reader, "missing-routing")!
    expect(missing.routing).toBeNull()
    expect(() => assertLiveTelemetry(first, missing, identity.id)).toThrow("Missing persisted")
    seedTelemetry(fixture.db, first, identity.id, "other-rule")
    const other = readLiveTelemetry(reader, "other-rule")!
    other.routing!.rule_id = "wrong-rule"
    expect(() => assertLiveTelemetry(first, other, identity.id)).toThrow()
  })

  test("counts replay attempts, nullable buckets, captured multipliers and incomplete usage honestly", () => {
    seedTelemetry(fixture.db, first, identity.id, "replay")
    const telemetry = readLiveTelemetry(reader, "replay")!
    const successful = telemetry.attempts[0]!
    const failed = { ...successful, input_tokens: null, cache_read_tokens: null, cache_write_tokens: null, output_tokens: null, usage_present: 0, usage_complete: 0, weighted_debit: 0 }
    telemetry.attempts = [failed, { ...successful, attempt_ordinal: 1 }]
    telemetry.routing!.usage_complete = false
    expect(() => assertLiveTelemetry(first, telemetry, identity.id)).not.toThrow()
    for (const attempt of telemetry.attempts) {
      attempt.multiplier = 1.5
      attempt.weighted_debit *= 1.5
    }
    telemetry.routing!.multiplier = 1.5
    telemetry.routing!.weighted_tokens = 18
    expect(() => assertLiveTelemetry(first, telemetry, identity.id)).not.toThrow()
  })

  test.each([
    ["no attempts", (value: any) => { value.attempts = [] }],
    ["no usage", (value: any) => { value.attempts[0].usage_present = 0 }],
    ["duplicate ordinal", (value: any) => { value.attempts.push(value.attempts[0]) }],
    ["invalid bucket", (value: any) => { value.attempts[0].input_tokens = -1 }],
    ["wrong debit", (value: any) => { value.attempts[0].weighted_debit = 99 }],
    ["wrong total", (value: any) => { value.routing.weighted_tokens = 99 }],
    ["wrong completion flag", (value: any) => { value.routing.usage_complete = false }],
    ["unhealthy accounting", (value: any) => { value.routing.accounting_healthy = false }],
    ["wrong capture", (value: any) => { value.attempts[0].captured_at++ }],
  ] as const)("rejects accounting %s", (_name, mutate) => {
    seedTelemetry(fixture.db, first, identity.id, "bad-accounting")
    const telemetry = readLiveTelemetry(reader, "bad-accounting")!
    mutate(telemetry)
    expect(() => assertLiveTelemetry(first, telemetry, identity.id)).toThrow()
  })
})

const cases = [first, liveCases.find((entry) => entry.protocol === "messages" && entry.stream)!, liveCases.find((entry) => entry.protocol === "responses" && entry.stream)!]

function options(selected: readonly LiveCase[] = cases) {
  const checkpoints: string[] = []
  return {
    cases: selected, url: "http://127.0.0.1:7024", key: identity.key, keyId: identity.id, db: reader,
    runId: "fixture-run", checkpoints,
    checkpoint(results: readonly LiveResult[]) { checkpoints.push(JSON.stringify(results)) },
  }
}

describe("one request per case and fail-fast execution", () => {
  test.each([false, true])("accepts a trailing Messages DONE only on native routes (native=%s)", async (native) => {
    const entry = liveCases.find(item => item.protocol === "messages" && item.stream && item.kind === "text" && (item.clientFormat === item.upstreamFormat) === native)!
    const results = await runLiveCases({ ...options([entry]), fetchImpl: async (_url, init) => {
      seedTelemetry(fixture.db, entry, identity.id, new Headers(init.headers).get("user-agent")!)
      return new Response(`${fixtureSse(entry)}data: [DONE]\r\n\r\n`, { headers: { "content-type": "text/event-stream" } })
    } })
    expect(results[0]!.status).toBe(native ? "passed" : "failed")
  })

  test.each([false, true])("accepts missing Chat SSE discriminators only on native routes (native=%s)", async (native) => {
    const entry = liveCases.find(item => item.protocol === "chat" && item.stream && item.kind === "text" && (item.clientFormat === item.upstreamFormat) === native)!
    const results = await runLiveCases({ ...options([entry]), fetchImpl: async (_url, init) => {
      seedTelemetry(fixture.db, entry, identity.id, new Headers(init.headers).get("user-agent")!)
      return new Response(fixtureSse(entry).replaceAll('"object":"chat.completion.chunk",', ""), { headers: { "content-type": "text/event-stream" } })
    } })
    expect(results[0]!.status).toBe(native ? "passed" : "failed")
  })

  test("exercises real loopback HTTP, all three protocols, fragmented CRLF SSE and DB correlation", async () => {
    const received: string[] = []
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const entry = cases[received.length]!
      received.push(new URL(request.url).pathname)
      expect(await request.json()).toEqual(entry.body)
      expect(request.headers.get(entry.protocol === "messages" ? "x-api-key" : "authorization")).toBe(entry.protocol === "messages" ? identity.key : `Bearer ${identity.key}`)
      seedTelemetry(fixture.db, entry, identity.id, request.headers.get("user-agent")!)
      if (!entry.stream) return Response.json(fixtureJson(entry))
      const bytes = new TextEncoder().encode(`: fixture heartbeat\r\n\r\nevent: ping\r\n\r\n${fixtureSse(entry)}`)
      return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
        controller.close()
      } }), { headers: { "content-type": "text/event-stream" } })
    } })
    try {
      const input = { ...options(), url: server.url.origin }
      const results = await runLiveCases(input)
      expect(results.map((entry) => entry.status)).toEqual(["passed", "passed", "passed"])
      expect(received).toEqual(cases.map((entry) => entry.path))
      expect(results[1]!.first_event_ms).toBeTypeOf("number")
      expect(input.checkpoints).toHaveLength(7)
      expect(input.checkpoints.join("\n")).not.toContain(identity.key)
      expect(JSON.parse(input.checkpoints[0]!)[0].status).toBe("not_run")
    } finally { server.stop(true) }
  })

  test("preserves a failed HTTP body and stops before the next case without replay", async () => {
    let calls = 0
    const input = options()
    const results = await runLiveCases({ ...input, fetchImpl: (async (_url, init) => {
      const entry = cases[calls++]!
      seedTelemetry(fixture.db, entry, identity.id, new Headers(init?.headers).get("user-agent")!, calls === 2 ? { status: "error", status_code: 429 } : {})
      return calls === 2 ? Response.json({ error: { message: "Fixture rate limit" } }, { status: 429 }) : Response.json(fixtureJson(entry))
    }) })
    expect(calls).toBe(2)
    expect(results.map((entry) => entry.status)).toEqual(["passed", "failed", "not_run"])
    expect(results[1]!.body).toContain("Fixture rate limit")
    expect(results[1]!.telemetry?.request.status_code).toBe(429)
    expect(results[1]!.errors).toEqual([expect.stringContaining("HTTP 429")])
  })

  test("stops after a Proxy-internal replay even if the final response succeeds", async () => {
    let calls = 0
    const results = await runLiveCases({ ...options(), fetchImpl: async (_url, init) => {
      calls++
      const name = new Headers(init.headers).get("user-agent")!
      const requestId = seedTelemetry(fixture.db, first, identity.id, name)
      fixture.db.query(`INSERT INTO quota_settlements
        (request_id, attempt_ordinal, upstream_id, window_id, captured_at, usage_present, usage_complete,
         input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, multiplier, weighted_debit)
        SELECT request_id, 1, upstream_id, window_id, captured_at, 0, 0,
         NULL, NULL, NULL, NULL, multiplier, 0 FROM quota_settlements WHERE request_id = ?`).run(requestId)
      fixture.db.query("UPDATE requests SET routing_details = json_set(routing_details, '$.usage_complete', json('false')) WHERE id = ?").run(requestId)
      return Response.json(fixtureJson(first))
    } })
    expect(calls).toBe(1)
    expect(results.map((entry) => entry.status)).toEqual(["failed", "not_run", "not_run"])
    expect(results[0]!.errors).toEqual([expect.stringContaining("Multiple upstream attempts")])
  })

  test.each([false, true])("rejects a wrong content type (stream=%s)", async (stream) => {
    const entry = { ...first, stream }
    const results = await runLiveCases({ ...options([entry]), fetchImpl: (async (_url, init) => {
      seedTelemetry(fixture.db, entry, identity.id, new Headers(init?.headers).get("user-agent")!)
      return new Response("fixture", { headers: { "content-type": "text/plain" } })
    }) })
    expect(results[0]!.errors[0]).toContain("content type")
    expect(results[0]!.body).toBe("fixture")
  })

  test("records non-Error transport failures and preserves telemetry", async () => {
    const results = await runLiveCases({ ...options([first]), fetchImpl: (async (_url, init) => {
      seedTelemetry(fixture.db, first, identity.id, new Headers(init?.headers).get("user-agent")!)
      throw "fixture-network-failure"
    }) })
    expect(results[0]!.errors).toEqual(["fixture-network-failure"])
    expect(results[0]!.telemetry?.attempts).toHaveLength(1)
  })

  test("waits for the persisted request after the response and rejects bad route evidence", async () => {
    const results = await runLiveCases({ ...options([first]), fetchImpl: (async (_url, init) => {
      const name = new Headers(init?.headers).get("user-agent")!
      setTimeout(() => seedTelemetry(fixture.db, first, identity.id, name, { strategy: "wrong-strategy" }), 10)
      return Response.json(fixtureJson(first))
    }) })
    expect(results[0]!.status).toBe("failed")
    expect(results[0]!.errors[0]).toContain("wrong-strategy")
  })

  test("fails closed when no matching request was persisted", async () => {
    const results = await runLiveCases({ ...options([first]), fetchImpl: async () => Response.json(fixtureJson(first)) })
    expect(results[0]!.errors).toEqual([expect.stringContaining("No persisted request")])
  })

  test("times out a stalled SSE body and cancels it once", async () => {
    const entry = cases[1]!
    let cancelled = 0
    const results = await runLiveCases({ ...options([entry]), timeoutMs: 20, fetchImpl: (async (_url, init) => {
      seedTelemetry(fixture.db, entry, identity.id, new Headers(init?.headers).get("user-agent")!)
      return new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { "content-type": "text/event-stream" } })
    }) })
    expect(results[0]!.status).toBe("failed")
    expect(results[0]!.errors).toHaveLength(1)
    expect(cancelled).toBe(1)
  })

  test("does not follow a redirect with the API key", async () => {
    let hits = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      hits++
      seedTelemetry(fixture.db, first, identity.id, request.headers.get("user-agent")!)
      return Response.redirect("http://127.0.0.1:1/should-not-be-requested")
    } })
    try {
      const results = await runLiveCases({ ...options([first]), url: server.url.origin })
      expect(results[0]!.status).toBe("failed")
      expect(hits).toBe(1)
    } finally { server.stop(true) }
  })
})

describe("CLI isolation and private artifacts", () => {
  test("plan mode requires no database, raw key or running Proxy", async () => {
    const child = Bun.spawn([process.execPath, "run", "scripts/verify-live-proxy.ts", "--case", first.id, "--db", "/absent/fixture.db", "--key-file", "/absent/key"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain("仅计划")
    expect(await new Response(child.stderr).text()).toBe("")
    const sidecar = Bun.spawn([process.execPath, "run", "scripts/live-proxy-sidecar.ts"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, RAVEN_DB_PATH: "/absent/fixture.db", RAVEN_TOKEN_PATH: "/absent/token" } })
    expect(await sidecar.exited).toBe(0)
    expect(await new Response(sidecar.stdout).text()).toContain("仅计划")
    expect(await new Response(sidecar.stderr).text()).toBe("")
    const invalid = Bun.spawn([process.execPath, "run", "scripts/live-proxy-sidecar.ts", "--execute", "--key-file", "/absent/key"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, RAVEN_API_KEY: "", RAVEN_INTERNAL_KEY: "", RAVEN_DB_PATH: "/absent/fixture.db" } })
    expect(await invalid.exited).toBe(1)
    expect(await new Response(invalid.stderr).text()).toContain("未重试")
  })

  test("preflights and executes against synthetic local HTTP only, retaining a private report without secrets", async () => {
    let generated = 0
    let guarded = "1"
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${identity.key}`)
      if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [{ id: "auto" }, { id: first.model }] }, { headers: { "x-raven-live-no-replay": guarded, "x-raven-live-revision": execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() } })
      generated++
      seedTelemetry(fixture.db, first, identity.id, request.headers.get("user-agent")!)
      return Response.json(fixtureJson(first))
    } })
    const data = join(dirname(fixture.path), "private-data")
    mkdirSync(data, { mode: 0o700 })
    try {
      for (const mode of ["--preflight", "--execute"]) {
        const child = Bun.spawn([process.execPath, "run", "scripts/verify-live-proxy.ts", mode, "--case", first.id, "--url", server.url.origin, "--db", fixture.path, ...(mode === "--execute" ? ["--key-stdin"] : ["--key-file", privateKeyPath])], {
          cwd: root, stdin: new TextEncoder().encode(`${identity.key}\n`), stdout: "pipe", stderr: "pipe", env: { ...process.env, RAVEN_DATA_DIR: data },
        })
        const code = await child.exited
        const stdout = await new Response(child.stdout).text()
        const stderr = await new Response(child.stderr).text()
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
        expect(stdout).not.toContain(identity.key)
        if (mode === "--preflight") expect(generated).toBe(0)
        else {
          expect(generated).toBe(1)
          const path = /报告：(.*)/.exec(stdout)![1]!
          expect(path.startsWith(`${data}/`)).toBe(true)
          expect(statSync(path).mode & 0o777).toBe(0o600)
          expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
          const raw = readFileSync(path, "utf8")
          expect(raw).not.toContain(identity.key)
          const report = JSON.parse(raw)
          expect(report.results[0].status).toBe("passed")
          expect(report.results[0].telemetry.attempts).toHaveLength(1)
          expect(report.git_commit).toMatch(/^[a-f0-9]{40}$/)
        }
      }
      guarded = "0"
      const unsafe = Bun.spawn([process.execPath, "run", "scripts/verify-live-proxy.ts", "--execute", "--case", first.id, "--url", server.url.origin, "--db", fixture.path, "--key-file", privateKeyPath], { cwd: root, stdout: "pipe", stderr: "pipe" })
      expect(await unsafe.exited).toBe(1)
      expect(await new Response(unsafe.stderr).text()).toContain("guarded sidecar")
      expect(generated).toBe(1)
    } finally { server.stop(true) }
  })

  test.each([{ args: [] }, { args: ["--key-file", "/absent/key"] }])("rejects invalid stdin credentials or ambiguous key sources before HTTP (%#)", async ({ args }) => {
    const child = Bun.spawn([process.execPath, "run", "scripts/verify-live-proxy.ts", "--preflight", "--key-stdin", ...args], { cwd: root, stdin: new TextEncoder().encode("fixture secret with whitespace"), stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(1)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain(args.length ? "Choose either" : "Supply one raw")
    expect(stderr).not.toContain("fixture secret")
  })
})
