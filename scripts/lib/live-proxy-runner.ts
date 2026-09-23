import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import type { RequestRoutingDetails } from "../../packages/proxy/src/core/routing-log"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../../packages/proxy/src/core/routing-types"
import type { NativeProtocolEvidence } from "../../packages/proxy/src/core/protocol-evidence"
import { getRoutingRule } from "../../packages/proxy/src/db/routing-rules"
import { events } from "../../packages/proxy/src/util/sse"
import type { LiveCase } from "./live-proxy-cases"
import { assertLiveReply, inspectFrames, inspectJson, requiresLiveUsage, wireObject, type LiveFrame, type LiveReply } from "./live-proxy-wire"

export function liveProxyUrl(value: string): string {
  const url = new URL(value)
  assert.ok(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Live tests require a loopback Proxy URL")
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "Use a Proxy origin without credentials, path, query or fragment")
  return url.origin
}

export function readLiveKey(path: string): string {
  const stat = statSync(path)
  assert.ok(stat.isFile() && stat.size <= 4096, "Key path must be a small plain-text file")
  assert.equal(stat.mode & 0o077, 0, "Key file must be private (chmod 600)")
  return parseLiveKey(readFileSync(path, "utf8"))
}

export function parseLiveKey(value: string): string {
  const key = value.trim()
  assert.ok(Buffer.byteLength(value) <= 4096 && key.length >= 12 && !/\s/.test(key), "Supply one raw API key (at most 4096 bytes)")
  return key
}

export function openLiveDatabase(path: string): Database {
  return new Database(path, { readwrite: true, create: false })
}

export function livePreflight(db: Database, key: string, cases: readonly LiveCase[]) {
  const hash = createHash("sha256").update(key).digest("hex")
  const identity = db.query<{ id: string; name: string; rule_id: string }, [string]>(
    "SELECT id, name, rule_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
  ).get(hash)
  assert.ok(identity, "The raw key does not match an active database key")
  assert.equal(identity.rule_id, COPILOT_RULE_ID, "Live cases require a key bound to the default Copilot rule")
  const rule = getRoutingRule(db, identity.rule_id)
  assert.ok(rule?.allow_conversion && rule.mode === "all_day", "Default rule must allow conversion and use all-day routing")
  assert.deepEqual(rule.default_chain, [{ upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }], "Default chain differs from this acceptance contract")
  const upstream = db.query<{ models: string; last_refreshed_at: number | null }, [string]>(
    "SELECT models, last_refreshed_at FROM providers WHERE id = ?",
  ).get(COPILOT_UPSTREAM_ID)
  assert.ok(upstream, "Copilot upstream is missing")
  const catalog = (JSON.parse(upstream.models) as unknown[]).map(wireObject)
  for (const item of cases) {
    const model = catalog.find((entry) => entry.id === item.resolvedModel)
    assert.ok(model, `Model missing from the existing Copilot cache: ${item.resolvedModel}`)
    const expected = item.upstreamFormat === "anthropic" ? "/v1/messages" : item.upstreamFormat === "openai" ? "/chat/completions" : "/responses"
    assert.ok(Array.isArray(model.supported_endpoints) && model.supported_endpoints.includes(expected), `Cached endpoints changed for ${item.resolvedModel}; review the expected route`)
  }
  return {
    key: identity, rule,
    catalog: catalog.map((model) => ({ id: model.id, supported_endpoints: model.supported_endpoints })),
    catalog_refreshed_at: upstream.last_refreshed_at,
  }
}

export interface LiveSettlement {
  attempt_ordinal: number
  upstream_id: string
  window_id: string | null
  captured_at: number
  usage_present: number
  usage_complete: number
  input_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  output_tokens: number | null
  multiplier: number
  weighted_debit: number
}

interface LiveRequest {
  id: string
  path: string
  model: string
  resolved_model: string | null
  api_key_id: string
  client_format: string
  upstream_format: string
  strategy: string
  stream: number
  status: string
  status_code: number
  upstream_status: number | null
  error_message: string | null
}

export interface LiveTelemetry {
  request: LiveRequest
  routing: RequestRoutingDetails | null
  attempts: LiveSettlement[]
}

export function readLiveTelemetry(db: Database, clientName: string): LiveTelemetry | null {
  const rows = db.query<LiveRequest & { routing_details: string | null }, [string]>(`SELECT
    id, path, model, resolved_model, api_key_id, client_format, upstream_format,
    strategy, stream, status, status_code, upstream_status, error_message, routing_details
    FROM requests WHERE client_name = ?`,
  ).all(clientName)
  assert.ok(rows.length <= 1, "Multiple requests matched one live case correlation ID")
  if (!rows.length) return null
  const { routing_details, ...request } = rows[0]!
  const attempts = db.query<LiveSettlement, [string]>(`SELECT attempt_ordinal, upstream_id,
    window_id, captured_at, usage_present, usage_complete, input_tokens, cache_read_tokens,
    cache_write_tokens, output_tokens, multiplier, weighted_debit
    FROM quota_settlements WHERE request_id = ? ORDER BY attempt_ordinal`).all(request.id)
  return { request, routing: routing_details ? JSON.parse(routing_details) as RequestRoutingDetails : null, attempts }
}

export function assertLiveTelemetry(item: LiveCase, telemetry: LiveTelemetry, keyId: string): void {
  const { request, routing, attempts } = telemetry
  assert.equal(request.api_key_id, keyId)
  assert.equal(request.path, item.path)
  assert.equal(request.model, item.model)
  assert.equal(request.client_format, item.clientFormat)
  assert.equal(request.upstream_format, item.upstreamFormat)
  assert.equal(request.strategy, item.strategy)
  assert.equal(request.stream, Number(item.stream))
  assert.equal(request.status, "success")
  assert.equal(request.status_code, 200)
  assert.ok(routing, "Missing persisted routing details")
  assert.equal(routing.rule_id, COPILOT_RULE_ID)
  assert.equal(routing.period_id, null)
  assert.equal(routing.upstream_id, COPILOT_UPSTREAM_ID)
  assert.equal(routing.requested_model, item.model)
  assert.equal(routing.resolved_model, item.resolvedModel)
  assert.equal(routing.diagnostic, false)
  assert.equal(routing.accounting_healthy, true)
  assert.deepEqual(routing.skipped, [])
  assert.ok(attempts.length > 0, "No actual upstream attempt was accounted for")
  if (requiresLiveUsage(item) || routing.quota_window_id !== null) assert.ok(attempts.some((attempt) => attempt.usage_present === 1), "No upstream usage was observed")
  let debit = 0
  for (const [index, attempt] of attempts.entries()) {
    assert.equal(attempt.attempt_ordinal, index, "Attempt ordinals are not consecutive")
    assert.equal(attempt.upstream_id, routing.upstream_id)
    assert.equal(attempt.window_id, routing.quota_window_id)
    assert.equal(attempt.captured_at, routing.admitted_at)
    assert.equal(attempt.multiplier, routing.multiplier)
    const buckets = [attempt.input_tokens, attempt.cache_read_tokens, attempt.cache_write_tokens, attempt.output_tokens]
    assert.ok(buckets.every((value) => value === null || (Number.isFinite(value) && value >= 0)), "Invalid settlement token bucket")
    const expected = buckets.reduce<number>((sum, value) => sum + (value ?? 0), 0) * attempt.multiplier
    assert.ok(Math.abs(attempt.weighted_debit - expected) < 0.000001, "Settlement debit does not match weighted usage")
    debit += attempt.weighted_debit
  }
  assert.ok(Math.abs(routing.weighted_tokens - debit) < 0.000001, "Routing debit does not match the attempt ledger")
  if (attempts.some(attempt => attempt.usage_present === 1)) assert.ok(debit > 0, "No tokens were accounted for a successful generation")
  else assert.equal(routing.usage_complete, false, "Absent usage must be marked incomplete")
  assert.equal(routing.usage_complete, attempts.every((attempt) => attempt.usage_complete === 1))
}

export interface LiveResult {
  case_id: string
  status: "not_run" | "running" | "passed" | "failed"
  client_name?: string
  started_at?: string
  duration_ms?: number
  http_status?: number
  content_type?: string
  body?: string
  frames?: LiveFrame[]
  first_event_ms?: number
  reply?: LiveReply
  telemetry?: LiveTelemetry | null
  errors: string[]
}

export async function runLiveCases(input: {
  cases: readonly LiveCase[]
  url: string
  key: string
  keyId: string
  db: Database
  runId: string
  checkpoint: (results: readonly LiveResult[]) => void
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}): Promise<LiveResult[]> {
  const url = liveProxyUrl(input.url)
  const fetchImpl = input.fetchImpl ?? fetch
  const results: LiveResult[] = input.cases.map((item) => ({ case_id: item.id, status: "not_run", errors: [] }))
  input.checkpoint(results)
  for (const [index, item] of input.cases.entries()) {
    const result = results[index]!
    const started = Date.now()
    const clientName = `RavenLive-${input.runId}-${item.id}`
    Object.assign(result, { status: "running", client_name: clientName, started_at: new Date(started).toISOString() })
    input.checkpoint(results)
    try {
      const signal = AbortSignal.timeout(input.timeoutMs ?? 120_000)
      const response = await fetchImpl(`${url}${item.path}`, {
        method: "POST", redirect: "error", signal,
        headers: {
          "Content-Type": "application/json", "User-Agent": clientName,
          ...(item.protocol === "messages" ? { "x-api-key": input.key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${input.key}` }),
        },
        body: JSON.stringify(item.body),
      })
      result.http_status = response.status
      result.content_type = response.headers.get("content-type") ?? ""
      const sse = result.content_type.toLowerCase().includes("text/event-stream")
      if (!response.ok || !item.stream || !sse) result.body = await response.text()
      assert.equal(response.status, 200, `Proxy returned HTTP ${response.status}`)
      if (item.stream) {
        assert.ok(sse, "Expected an SSE content type")
        result.frames = []
        for await (const frame of events(response, signal)) {
          if (!frame.data) continue
          result.first_event_ms ??= Date.now() - started
          result.frames.push({ event: frame.event, data: frame.data })
        }
        result.reply = inspectFrames(item.protocol, result.frames)
      } else {
        assert.ok(/\bapplication\/(?:json|[^;]+\+json)\b/i.test(result.content_type), "Expected a JSON content type")
        result.reply = inspectJson(item.protocol, JSON.parse(result.body!), item.protocol === "chat" && item.clientFormat === item.upstreamFormat)
      }
      assertLiveReply(item, result.reply)
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
    try {
      for (let read = 0; read < 60; read++) {
        result.telemetry = readLiveTelemetry(input.db, clientName)
        if (result.telemetry) break
        await delay(50)
      }
      assert.ok(result.telemetry, "No persisted request matched this live case")
      if (!result.errors.length) {
        assertLiveTelemetry(item, result.telemetry, input.keyId)
        assert.equal(result.telemetry.attempts.length, 1, "Multiple upstream attempts observed; stop without sending another case")
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
    result.duration_ms = Date.now() - started
    result.status = result.errors.length ? "failed" : "passed"
    input.checkpoint(results)
    if (result.status === "failed") break
  }
  return results
}

export function liveNativeEvidence(cases: readonly LiveCase[], results: readonly LiveResult[], revision: string): NativeProtocolEvidence[] {
  return results.flatMap(result => {
    const item = cases.find(entry => entry.id === result.case_id)
    if (!item || result.status !== "passed" || item.kind !== "text" || item.model === "auto" || item.clientFormat !== item.upstreamFormat) return []
    assert.ok(result.started_at && result.telemetry?.attempts.length === 1, "Native evidence needs a dated, single-attempt result")
    assert.equal(result.telemetry.request.client_format, item.clientFormat)
    assert.equal(result.telemetry.request.upstream_format, item.clientFormat)
    assert.match(revision, /^[a-f0-9]{40}$/)
    return [{ upstream: "copilot", model: item.resolvedModel, protocol: item.upstreamFormat, stream: item.stream, tested_at: result.started_at, revision, case_id: item.id }]
  })
}
